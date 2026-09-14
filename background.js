// Фоновая страница расширения «Двери».
//
// Живёт всю сессию, поэтому здесь всё, что должно работать при закрытой панели:
// иконки дверей в сцене, пункты контекстного меню, броски и вердикт мастера.
//
// Сложности дверей намеренно не попадают ни в сцену, ни в метаданные комнаты:
// всё, что туда кладётся, синхронизируется игрокам и читается через инструменты
// разработчика. Сложности лежат в localStorage мастера, сравнение делает его
// клиент — игроки видят бросок и исход, но не порог.

import OBR from "https://cdn.jsdelivr.net/npm/@owlbear-rodeo/sdk@3.1.0/+esm";
import { collectDoors, distance, FOG_DOORS_KEY } from "./geometry.js";
import { rollD20, describe } from "./dice.js";
import { ID, ICON_KEY, PLAYERS_KEY, CH_ROLL, CH_RESULT, loadDC, loadLocalRoll } from "./store.js";

const REACH = 320;                 // около двух клеток по 150 единиц

let isGM = false;
let myId = null;
let doors = [];
let players = {};

// ---------- иконки ----------

function iconSvg(state) {
  const color = state === "open" ? "#6bbf82" : state === "locked" ? "#b06058" : "#c9a96e";
  const body = state === "open"
    ? `<path d="M7 4h7v16H7z" fill="none" stroke="${color}" stroke-width="2"/>
       <path d="M14 7l4-2v14l-4-2" fill="none" stroke="${color}" stroke-width="2"/>`
    : `<rect x="6" y="3" width="12" height="18" rx="1" fill="none" stroke="${color}" stroke-width="2"/>
       <circle cx="14.5" cy="12" r="1.3" fill="${color}"/>`;
  const lock = state === "locked"
    ? `<path d="M9.5 10.5V9a2.5 2.5 0 015 0v1.5" fill="none" stroke="${color}" stroke-width="1.6"/>`
    : "";
  return "data:image/svg+xml," + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
       <rect x="2" y="2" width="20" height="20" rx="4" fill="#14131a" opacity="0.72"/>
       ${body}${lock}</svg>`);
}

function stateOf(door, dc) {
  if (door.open) return "open";
  return dc?.[door.id]?.locked ? "locked" : "closed";
}

function iconItem(door, state) {
  const size = 75;                  // примерно половина клетки
  return {
    id: `${ID}-${door.id}`,
    type: "IMAGE",
    name: "Дверь",
    layer: "PROP",
    position: { x: door.x, y: door.y },
    rotation: 0,
    scale: { x: 1, y: 1 },
    visible: true,
    locked: true,                   // чтобы игроки не растащили двери по карте
    zIndex: 9000000,
    image: { url: iconSvg(state), width: size, height: size, mime: "image/svg+xml" },
    grid: { dpi: size, offset: { x: size / 2, y: size / 2 } },
    text: { type: "PLAIN", plainText: "", richText: [], style: {} },
    textItemType: "TEXT",
    metadata: { [ICON_KEY]: { doorId: door.id, itemId: door.itemId, index: door.index } },
  };
}

export async function syncIcons() {
  const items = await OBR.scene.items.getItems();
  doors = collectDoors(items.filter((i) => !i.metadata?.[ICON_KEY]));
  if (!isGM) return doors;          // добавлять элементы может только мастер

  const dc = loadDC();
  const existing = items.filter((i) => i.metadata?.[ICON_KEY]);
  const wanted = new Map(doors.map((d) => [`${ID}-${d.id}`, d]));

  const stale = existing.filter((i) => !wanted.has(i.id)).map((i) => i.id);
  if (stale.length) await OBR.scene.items.deleteItems(stale);

  const have = new Set(existing.map((i) => i.id));
  const add = doors.filter((d) => !have.has(`${ID}-${d.id}`))
                   .map((d) => iconItem(d, stateOf(d, dc)));
  if (add.length) await OBR.scene.items.addItems(add);

  const keep = existing.filter((i) => wanted.has(i.id)).map((i) => i.id);
  if (keep.length) {
    await OBR.scene.items.updateItems(keep, (list) => {
      for (const it of list) {
        const d = wanted.get(it.id);
        if (!d) continue;
        const url = iconSvg(stateOf(d, dc));
        if (it.image.url !== url) it.image.url = url;
        it.position = { x: d.x, y: d.y };
      }
    });
  }
  return doors;
}

export async function clearIcons() {
  const items = await OBR.scene.items.getItems();
  const ids = items.filter((i) => i.metadata?.[ICON_KEY]).map((i) => i.id);
  if (ids.length) await OBR.scene.items.deleteItems(ids);
  return ids.length;
}

// ---------- действия игрока ----------

async function doorFromElement(elementId) {
  const items = await OBR.scene.items.getItems([elementId]);
  const meta = items[0]?.metadata?.[ICON_KEY];
  if (!meta) return null;
  if (!doors.length) await syncIcons();
  return doors.find((d) => d.id === meta.doorId) || null;
}

async function actingToken() {
  const sel = await OBR.player.getSelection();
  if (!sel || sel.length !== 1) return { error: "Выдели один свой токен и попробуй снова." };
  const items = await OBR.scene.items.getItems(sel);
  const tok = items[0];
  if (!tok) return { error: "Не нашёл выделенный токен." };
  if (tok.metadata?.[ICON_KEY]) return { error: "Выдели токен персонажа, а не дверь." };
  return { token: tok };
}

async function attempt(elementId, kind) {
  const door = await doorFromElement(elementId);
  if (!door) return;
  if (door.open) return OBR.notification.show("Дверь уже открыта.", "DEFAULT");

  const { token, error } = await actingToken();
  if (error) return OBR.notification.show(error, "WARNING");
  if (distance(token.position, door) > REACH) {
    return OBR.notification.show("Слишком далеко от двери.", "WARNING");
  }

  const name = (await OBR.player.getName()) || "Игрок";
  const base = { doorId: door.id, kind, name, playerId: myId };

  if (kind === "open") {
    return OBR.broadcast.sendMessage(CH_ROLL, base, { destination: "ALL" });
  }

  const mods = players[myId] || {};
  const { bonus, mode } = loadLocalRoll();
  const mod = Number(kind === "pick" ? mods.sleight ?? 0 : mods.str ?? 0) + bonus;
  const r = rollD20(mod, mode);
  await OBR.broadcast.sendMessage(CH_ROLL, {
    ...base,
    total: r.total, detail: describe(r), crit: r.crit, fumble: r.fumble,
    label: kind === "pick" ? "взлом замка" : "выбить дверь",
  }, { destination: "ALL" });
}

// ---------- вердикт (только мастер) ----------

async function setOpen(door, open) {
  await OBR.scene.items.updateItems([door.itemId], (items) => {
    for (const it of items) {
      const list = it.metadata?.[FOG_DOORS_KEY];
      if (Array.isArray(list) && list[door.index]) list[door.index].open = open;
    }
  });
  await syncIcons();
}

async function announce(text, kind) {
  await OBR.broadcast.sendMessage(CH_RESULT, { text, kind }, { destination: "ALL" });
  OBR.notification.show(text, kind === "ok" ? "SUCCESS" : "WARNING");
}

async function judge(msg) {
  if (!doors.length) await syncIcons();
  const door = doors.find((d) => d.id === msg.doorId);
  if (!door) return;
  const dc = loadDC()[msg.doorId] || {};

  if (msg.kind === "open") {
    if (dc.locked) return announce(`${msg.name}: заперто.`, "fail");
    await setOpen(door, true);
    return announce(`${msg.name}: дверь открыта.`, "ok");
  }

  const target = Number(msg.kind === "pick" ? dc.pick ?? 15 : dc.force ?? 15);
  const ok = msg.crit || (!msg.fumble && msg.total >= target);
  if (ok) {
    await setOpen(door, true);
    return announce(`${msg.total} — дверь распахнулась.`, "ok");
  }
  return announce(`${msg.total} — не удалось.`, "fail");
}

// ---------- меню на иконке ----------

const HAS_ICON = { every: [{ key: ["metadata", ICON_KEY], operator: "!=", value: undefined }] };

async function installMenu() {
  const entry = (suffix, label, icon, kind) => OBR.contextMenu.create({
    id: `${ID}/${suffix}`,
    icons: [{ icon, label, filter: HAS_ICON }],
    onClick: (ctx) => attempt(ctx.items[0].id, kind),
  });
  await entry("open", "Открыть", "/icon.svg", "open");
  await entry("pick", "Взлом (Ловкость рук)", "/icon.svg", "pick");
  await entry("force", "Выбить (Сила)", "/icon.svg", "force");
}

// ---------- запуск ----------

OBR.onReady(async () => {
  myId = await OBR.player.getId();
  isGM = (await OBR.player.getRole()) === "GM";

  const meta = await OBR.room.getMetadata();
  players = meta[PLAYERS_KEY] || {};
  OBR.room.onMetadataChange((m) => { players = m[PLAYERS_KEY] || {}; });

  OBR.broadcast.onMessage(CH_RESULT, (e) => {
    OBR.notification.show(e.data.text, e.data.kind === "ok" ? "SUCCESS" : "WARNING");
  });
  OBR.broadcast.onMessage(CH_ROLL, (e) => {
    const m = e.data;
    if (m.detail && m.playerId !== myId) {
      OBR.notification.show(`${m.name}: ${m.label} — ${m.total}`, "DEFAULT");
    }
    if (isGM) judge(m);
  });

  await installMenu();

  if (isGM) {
    if (await OBR.scene.isReady()) await syncIcons();
    OBR.scene.onReadyChange(async (ready) => { if (ready) await syncIcons(); });
    // двери могли открыть/закрыть в самом Dynamic Fog — держим иконки в курсе
    let t = null;
    OBR.scene.items.onChange(() => {
      clearTimeout(t);
      t = setTimeout(() => syncIcons().catch(() => {}), 400);
    });
  } else {
    if (await OBR.scene.isReady()) await syncIcons();
    OBR.scene.items.onChange(() => { syncIcons().catch(() => {}); });
  }

  window.__doors = { syncIcons, clearIcons, getDoors: () => doors };
});
