// Общие ключи и локальное хранилище.
//
// localStorage у фоновой страницы и у панели общий (один origin), поэтому
// сложности дверей и ситуативный бонус передаются через него, а не через
// метаданные комнаты — так они не уезжают к игрокам.

export const ID = "com.cos.doors";
export const ICON_KEY = `${ID}/icon`;
export const PLAYERS_KEY = `${ID}/players`;   // модификаторы игроков, room metadata
export const ATTEMPTS_KEY = `${ID}/attempts`; // израсходованные попытки, room metadata

// Сколько раз один игрок может пробовать одну дверь каждым способом.
export const MAX_TRIES = 3;
export const CH_ROLL = `${ID}/roll`;          // бросок игрока -> всем
export const CH_RESULT = `${ID}/result`;      // вердикт мастера -> всем

const LS_DC = `${ID}:dc`;
const LS_ROLL = `${ID}:roll`;

export function loadDC() {
  try { return JSON.parse(localStorage.getItem(LS_DC) || "{}"); }
  catch { return {}; }
}

export function saveDC(map) {
  try { localStorage.setItem(LS_DC, JSON.stringify(map)); } catch {}
}

// Ситуативный бонус и режим броска, которые игрок выставил в своей панели.
export function loadLocalRoll() {
  try {
    const v = JSON.parse(localStorage.getItem(LS_ROLL) || "{}");
    const mode = v.mode === "adv" || v.mode === "dis" ? v.mode : "normal";
    return { bonus: Number(v.bonus || 0), mode };
  } catch {
    return { bonus: 0, mode: "normal" };
  }
}

export function saveLocalRoll(bonus, mode) {
  try { localStorage.setItem(LS_ROLL, JSON.stringify({ bonus, mode })); } catch {}
}

// Разбор числа из поля ввода. Именно здесь раньше терялись минусы и пустые
// значения: "" и "-" должны давать 0, а "-2" — минус два.
export function num(v) {
  if (v === null || v === undefined) return 0;
  const n = parseFloat(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

// Модификаторы игрока. Ищем по идентификатору, а если мастер завёл запись
// вручную по имени — то и по имени: иначе показатели молча считались нулём.
export function modsFor(players, playerId, playerName) {
  const byId = players?.[playerId];
  if (byId) return { str: num(byId.str), sleight: num(byId.sleight), found: true };
  const name = String(playerName || "").trim().toLowerCase();
  for (const p of Object.values(players || {})) {
    if (String(p.name || "").trim().toLowerCase() === name && name) {
      return { str: num(p.str), sleight: num(p.sleight), found: true };
    }
  }
  return { str: 0, sleight: 0, found: false };
}
