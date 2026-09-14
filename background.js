// Фоновая страница расширения «Двери».
//
// Живёт всю сессию, поэтому здесь всё, что должно работать при закрытой панели:
// иконки дверей в сцене, пункты контекстного меню, броски и вердикт мастера.
//
// Сложности дверей намеренно не попадают ни в сцену, ни в метаданные комнаты:
// всё, что туда кладётся, синхронизируется игрокам и читается через инструменты
// разработчика. Сложности лежат в localStorage мастера, сравнение делает его
// клиент — игроки видят бросок и исход, но не порог.

import OBR, { buildImage, isImage } from "https://cdn.jsdelivr.net/npm/@owlbear-rodeo/sdk@3.1.0/+esm";
import { collectDoors, distance, FOG_DOORS_KEY } from "./geometry.js";
import { rollD20, describe } from "./dice.js";
import { ID, ICON_KEY, PLAYERS_KEY, CH_ROLL, CH_RESULT, loadDC, loadLocalRoll } from "./store.js";

const REACH = 320;                 // около двух клеток по 150 единиц

let isGM = false;
let myId = null;
let doors = [];
let players = {};
let lastToken = null;      // последний выделенный токен, не считая дверей

// ---------- иконки ----------

// Иконки лежат рядом с расширением обычными файлами: Owlbear грузит картинки
// по адресу, а data:-ссылки для элементов сцены не годятся.
const ICON_URL = {
  closed: new URL("./door-closed.svg", location.href).href,
  open: new URL("./door-open.svg", location.href).href,
  locked: new URL("./door-locked.svg", location.href).href,
};

function stateOf(door, dc) {
  if (door.open) return "open";
  return dc?.[door.id]?.locked ? "locked" : "closed";
}

// Элемент собираем построителем SDK: вручную собранный объект Owlbear отклоняет.
function iconItem(door, state) {
  const size = 48;
  const dpi = 96;                    // 48px при dpi 96 = половина клетки
  return buildImage(
    { url: ICON_URL[state], width: size, height: size, mime: "image/svg+xml" },
    { dpi, offset: { x: size / 2, y: size / 2 } },
  )
    .id(`${ID}-${door.id}`)
    .name("Дверь")
    .layer("PROP")
    .position({ x: door.x, y: door.y })
    .locked(true)
    .visible(true)
    .metadata({ [ICON_KEY]: { doorId: door.id, itemId: door.itemId, index: door.index } })
    .build();
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
  if (add.length) {
    try {
      await OBR.scene.items.addItems(add);
    } catch (err) {
      // молчаливый провал здесь уже случался — пусть будет видно
      console.error("[Двери] не удалось добавить иконки", err);
      OBR.notification.show("Не удалось добавить иконки дверей: " + err.message, "ERROR");
      throw err;
    }
  }

  const keep = existing.filter((i) => wanted.has(i.id)).map((i) => i.id);
  if (keep.length) {
    await OBR.scene.items.updateItems(keep, (list) => {
      for (const it of list) {
        const d = wanted.get(it.id);
        if (!d) continue;
        if (!isImage(it)) continue;
        const url = ICON_URL[stateOf(d, dc)];
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

// Кто действует. На выделение полагаться нельзя: правый клик по двери сам её
// выделяет, и к моменту обработки в выделении лежит дверь, а не токен. Поэтому
// берём последний выделенный токен, а если его нет — ближайшего персонажа у двери.
async function actingToken(door) {
  const items = await OBR.scene.items.getItems();
  const isIcon = (i) => !!i.metadata?.[ICON_KEY];

  if (lastToken) {
    const tok = items.find((i) => i.id === lastToken && !isIcon(i));
    if (tok) return { token: tok };
  }

  const near = items
    .filter((i) => i.layer === "CHARACTER" && !isIcon(i))
    .map((i) => ({ i, d: distance(i.position, door) }))
    .filter((x) => x.d <= REACH)
    .sort((a, b) => a.d - b.d);

  if (near.length) return { token: near[0].i, guessed: true };
  return { error: "Рядом с дверью нет твоего токена. Выдели его и подойди ближе." };
}

async function attempt(elementId, kind) {
  const door = await doorFromElement(elementId);
  if (!door) return;
  if (door.open) return OBR.notification.show("Дверь уже открыта.", "DEFAULT");

  const { token, error } = await actingToken(door);
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
  if (isGM) {
    // форма настройки открывается прямо на двери, чтобы не искать её в списке
    await OBR.contextMenu.create({
      id: `${ID}/setup`,
      icons: [{ icon: "/icon.svg", label: "Настроить дверь", filter: HAS_ICON }],
      embed: { url: "/menu.html", height: 104 },
    });
  }
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

  // следим за выделением, чтобы знать, каким токеном игрок действует
  OBR.player.onChange(async (p) => {
    const sel = p?.selection;
    if (!sel || sel.length !== 1) return;
    try {
      const [it] = await OBR.scene.items.getItems(sel);
      if (it && !it.metadata?.[ICON_KEY]) lastToken = it.id;
    } catch {}
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
