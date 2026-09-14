// Общие ключи и локальное хранилище.
//
// localStorage у фоновой страницы и у панели общий (один origin), поэтому
// сложности дверей и ситуативный бонус передаются через него, а не через
// метаданные комнаты — так они не уезжают к игрокам.

export const ID = "com.cos.doors";
export const ICON_KEY = `${ID}/icon`;
export const PLAYERS_KEY = `${ID}/players`;   // модификаторы игроков, room metadata
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
