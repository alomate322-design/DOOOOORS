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
import { playUnlock, playFail, playClose, playRoll } from "./sfx.js";
import { ID, ICON_KEY, PLAYERS_KEY, ATTEMPTS_KEY, CH_ROLL, CH_RESULT,
         loadDC, saveDC, loadLocalRoll, MAX_TRIES } from "./store.js";

const REACH = 320;                 // около двух клеток по 150 единиц

let isGM = false;
let myId = null;
let doors = [];
let players = {};
let lastToken = null;      // последний выделенный токен, не считая дверей
let attempts = {};         // попытки: {doorId: {playerId: {pick, force}}}, room metadata

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
  const d = dc?.[door.id];
  // если замок уже сломали, дверь дальше просто закрыта
  return d?.locked && !d.broken ? "locked" : "closed";
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
  // «уже открыта» касается только открывания: закрывать открытую дверь как раз и надо
  if (kind === "close" && !door.open) {
    return OBR.notification.show("Дверь и так закрыта.", "DEFAULT");
  }
  if (kind !== "close" && door.open) {
    return OBR.notification.show("Дверь уже открыта.", "DEFAULT");
  }

  const { token, error } = await actingToken(door);
  if (error) return OBR.notification.show(error, "WARNING");
  if (distance(token.position, door) > REACH) {
    return OBR.notification.show("Слишком далеко от двери.", "WARNING");
  }

  const name = (await OBR.player.getName()) || "Игрок";
  const base = { doorId: door.id, kind, name, playerId: myId };

  if (kind === "open" || kind === "close") {
    return OBR.broadcast.sendMessage(CH_ROLL, base, { destination: "ALL" });
  }

  const used = attempts?.[door.id]?.[myId]?.[kind] || 0;
  if (used >= MAX_TRIES) {
    return OBR.notification.show(
      kind === "pick" ? "Взломать больше не выходит — попытки кончились."
                      : "Выбить не получается — силы кончились.", "WARNING");
  }

  const mods = players[myId] || {};
  const { bonus, mode } = loadLocalRoll();
  const mod = Number(kind === "pick" ? mods.sleight ?? 0 : mods.str ?? 0) + bonus;
  playRoll();
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

// Рассылаем всем один раз: раньше мастер показывал уведомление и локально,
// и через рассылку, отчего оно двоилось.
async function announce(text, kind) {
  await OBR.broadcast.sendMessage(CH_RESULT, { text, kind }, { destination: "ALL" });
}

async function bumpAttempt(doorId, playerId, kind) {
  const next = { ...attempts };
  const perDoor = { ...(next[doorId] || {}) };
  const perPlayer = { ...(perDoor[playerId] || {}) };
  perPlayer[kind] = (perPlayer[kind] || 0) + 1;
  perDoor[playerId] = perPlayer;
  next[doorId] = perDoor;
  attempts = next;
  await OBR.room.setMetadata({ [ATTEMPTS_KEY]: next });
  return perPlayer[kind];
}

async function judge(msg) {
  if (!doors.length) await syncIcons();
  const door = doors.find((d) => d.id === msg.doorId);
  if (!door) return;
  const map = loadDC();
  const dc = map[msg.doorId] || {};

  if (msg.kind === "close") {
    if (!door.open) return;
    await setOpen(door, false);
    return announce(`${msg.name}: дверь закрыта.`, "close");
  }

  if (msg.kind === "open") {
    // замок, который уже сломали, больше не мешает
    if (dc.locked && !dc.broken) return announce(`${msg.name}: заперто.`, "fail");
    await setOpen(door, true);
    return announce(`${msg.name}: дверь открыта.`, "ok");
  }

  const used = await bumpAttempt(msg.doorId, msg.playerId, msg.kind);
  const target = Number(msg.kind === "pick" ? dc.pick ?? 15 : dc.force ?? 15);
  const ok = msg.crit || (!msg.fumble && msg.total >= target);
  const left = Math.max(0, MAX_TRIES - used);

  if (ok) {
    // дверь больше не заперта: дальше открывается и закрывается свободно
    map[msg.doorId] = { ...dc, broken: true };
    saveDC(map);
    await setOpen(door, true);
    const how = msg.kind === "pick" ? "замок поддался" : "дверь выбита";
    return announce(`${msg.name}: ${msg.total} — ${how}!`, "ok");
  }
  const tail = left ? ` Осталось попыток: ${left}.` : " Попытки кончились.";
  return announce(`${msg.name}: ${msg.total} — не удалось.${tail}`, "fail");
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
  await entry("close", "Закрыть", "/icon.svg", "close");
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
  attempts = meta[ATTEMPTS_KEY] || {};
  OBR.room.onMetadataChange((m) => {
    players = m[PLAYERS_KEY] || {};
    attempts = m[ATTEMPTS_KEY] || {};
  });

  OBR.broadcast.onMessage(CH_RESULT, (e) => {
    const { text, kind } = e.data;
    OBR.notification.show(text,
      kind === "ok" ? "SUCCESS" : kind === "close" ? "DEFAULT" : "WARNING");
    if (kind === "ok") playUnlock();
    else if (kind === "close") playClose();
    else playFail();
  });
  OBR.broadcast.onMessage(CH_ROLL, (e) => {
    const m = e.data;
    if (m.detail) {
      // бросок видят все, включая самого бросавшего
      OBR.notification.show(`🎲 ${m.name} — ${m.label}: ${m.detail}`, "DEFAULT");
      if (m.playerId !== myId) playRoll();
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
