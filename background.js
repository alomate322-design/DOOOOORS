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
import { ID, ICON_KEY, PLAYERS_KEY, ATTEMPTS_KEY, CH_ROLL, CH_RESULT,
         loadDC, saveDC, loadLocalRoll, MAX_TRIES, modsFor } from "./store.js";

const REACH = 320;                 // около двух клеток по 150 единиц

let isGM = false;
let myId = null;
let doors = [];
let players = {};
let lastToken = null;      // последний выделенный токен, не считая дверей
let fogSignature = "";     // отпечаток дверей: пересчитываем, только когда он изменился
let syncTimer = null;
let syncPending = null;
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

// Отпечаток дверей: id куска тумана, число дверей и их состояние. Пока он тот
// же, геометрию пересчитывать незачем — а она считалась на каждое движение
// любого токена на карте.
function hash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return h;
}

function signatureOf(items) {
  // В отпечаток входят и настройки дверей: иначе смена «заперта» или Сл не
  // перерисовывала иконку — отпечаток тумана-то прежний.
  let sig = isGM ? "dc" + hash(JSON.stringify(loadDC())) + "|" : "";
  for (const i of items) {
    const d = i.metadata?.[FOG_DOORS_KEY];
    if (!Array.isArray(d) || !d.length) continue;
    sig += i.id + ":" + d.length + ":";
    for (const x of d) sig += x.open ? "1" : "0";
    sig += "|";
  }
  return sig;
}

export async function syncIcons(force = false) {
  const items = await OBR.scene.items.getItems();
  const sig = signatureOf(items);
  const changed = sig !== fogSignature;
  if (!changed && !force && doors.length) return doors;
  fogSignature = sig;
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

  // Правим только те иконки, у которых действительно поменялись картинка или
  // место. Раньше переписывались все 50 на каждый чих, и каждая правка — это
  // сетевое сообщение всем участникам.
  const dirty = [];
  for (const it of existing) {
    const d = wanted.get(it.id);
    if (!d) continue;
    const url = ICON_URL[stateOf(d, dc)];
    const moved = Math.abs(it.position.x - d.x) > 0.5 || Math.abs(it.position.y - d.y) > 0.5;
    if (it.image?.url !== url || moved) dirty.push(it.id);
  }
  if (dirty.length) {
    const byId = new Map(dirty.map((id) => [id, wanted.get(id)]));
    await OBR.scene.items.updateItems(dirty, (list) => {
      for (const it of list) {
        const d = byId.get(it.id);
        if (!d || !isImage(it)) continue;
        it.image.url = ICON_URL[stateOf(d, dc)];
        it.position = { x: d.x, y: d.y };
      }
    });
  }
  return doors;
}

// Схлопываем частые события сцены в один пересчёт.
function scheduleSync(delay = 250) {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncTimer = null;
    syncPending = syncIcons().catch(() => {});
  }, delay);
}

export async function clearIcons() {
  const items = await OBR.scene.items.getItems();
  const ids = items.filter((i) => i.metadata?.[ICON_KEY]).map((i) => i.id);
  if (ids.length) await OBR.scene.items.deleteItems(ids);
  return ids.length;
}

// ---------- действия игрока ----------

function doorFromItems(elementId, items) {
  const meta = items.find((i) => i.id === elementId)?.metadata?.[ICON_KEY];
  if (!meta) return null;
  return doors.find((d) => d.id === meta.doorId) || null;
}

// Кто действует. На выделение полагаться нельзя: правый клик по двери сам её
// выделяет, и к моменту обработки в выделении лежит дверь, а не токен. Поэтому
// берём последний выделенный токен, а если его нет — ближайшего персонажа у двери.
// Кто действует. На выделение полагаться нельзя: правый клик по двери сам её
// выделяет, и к моменту обработки в выделении лежит дверь, а не токен. Поэтому
// берём последний выделенный токен, а если его нет — ближайшего персонажа у двери.
// items передаём снаружи: раньше на одну попытку делалось два обхода сцены.
function actingToken(door, items) {
  const isIcon = (i) => !!i.metadata?.[ICON_KEY];

  if (lastToken) {
    const tok = items.find((i) => i.id === lastToken && !isIcon(i));
    if (tok) return { token: tok };
  }

  let best = null;
  let bestDist = Infinity;
  for (const i of items) {
    if (i.layer !== "CHARACTER" || isIcon(i)) continue;
    const d = distance(i.position, door);
    if (d <= REACH && d < bestDist) { best = i; bestDist = d; }
  }
  if (best) return { token: best, guessed: true };
  return { error: "Рядом с дверью нет твоего токена. Выдели его и подойди ближе." };
}

async function attempt(elementId, kind) {
  if (syncPending) await syncPending;           // не работаем по устаревшему кэшу
  const items = await OBR.scene.items.getItems();
  if (!doors.length) await syncIcons(true);
  const door = doorFromItems(elementId, items);
  if (!door) return;
  // «уже открыта» касается только открывания: закрывать открытую дверь как раз и надо
  if (kind === "close" && !door.open) {
    return OBR.notification.show("Дверь и так закрыта.", "DEFAULT");
  }
  if (kind !== "close" && door.open) {
    return OBR.notification.show("Дверь уже открыта.", "DEFAULT");
  }

  const { token, error } = actingToken(door, items);
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

  const mods = modsFor(players, myId, name);
  if (!mods.found) {
    OBR.notification.show(
      "Мастер не задал твои показатели — бросок идёт без модификатора.", "WARNING");
  }
  const { bonus, mode } = loadLocalRoll();
  const mod = (kind === "pick" ? mods.sleight : mods.str) + bonus;
  const r = rollD20(mod, mode);
  const label = kind === "pick" ? "взлом замка" : "выбить дверь";
  // показываем свой бросок немедленно: ждать возврата рассылки — лишняя задержка
  OBR.notification.show(`🎲 ${name} — ${label}: ${describe(r)}`, "DEFAULT");
  await OBR.broadcast.sendMessage(CH_ROLL, {
    ...base,
    total: r.total, detail: describe(r), crit: r.crit, fumble: r.fumble,
    label,
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
  door.open = open;
  // меняем только одну иконку вместо полного пересчёта сцены
  const dc = loadDC();
  try {
    await OBR.scene.items.updateItems([`${ID}-${door.id}`], (list) => {
      for (const it of list) if (isImage(it)) it.image.url = ICON_URL[stateOf(door, dc)];
    });
  } catch {}
  fogSignature = "";                // отпечаток устарел
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
  });
  OBR.broadcast.onMessage(CH_ROLL, (e) => {
    const m = e.data;
    // свой бросок уже показан локально — здесь только чужие
    if (m.detail && m.playerId !== myId) {
      OBR.notification.show(`🎲 ${m.name} — ${m.label}: ${m.detail}`, "DEFAULT");
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

  if (await OBR.scene.isReady()) await syncIcons(true);
  OBR.scene.onReadyChange(async (ready) => {
    if (ready) { fogSignature = ""; await syncIcons(true); }
  });
  // Двери могли открыть в самом Dynamic Fog. Реагируем с задержкой и только на
  // настоящие изменения: раньше у игроков это срабатывало на каждый сдвиг токена.
  OBR.scene.items.onChange(() => scheduleSync(isGM ? 300 : 500));

  window.__doors = { syncIcons, clearIcons, getDoors: () => doors };
});
