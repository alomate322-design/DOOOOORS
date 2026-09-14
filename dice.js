// Движок бросков. Ничего не знает про интерфейс — только считает и отдаёт результат.

const DICE_RE = /([+-]?)\s*(\d*)\s*[dкдК](\d+)|([+-]?\s*\d+)/g;

function d(sides) {
  // crypto вместо Math.random: за столом важно, чтобы броски были честными
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return (buf[0] % sides) + 1;
}

// "2d6+3" -> {dice:[{n:2,sides:6,sign:1}], flat:3}
export function parseFormula(formula) {
  const dice = [];
  let flat = 0;
  const src = String(formula).replace(/\s+/g, "");
  DICE_RE.lastIndex = 0;
  let m;
  while ((m = DICE_RE.exec(src)) !== null) {
    if (m[3] !== undefined) {
      const sign = m[1] === "-" ? -1 : 1;
      dice.push({ n: m[2] ? parseInt(m[2], 10) : 1, sides: parseInt(m[3], 10), sign });
    } else if (m[4] !== undefined) {
      flat += parseInt(m[4].replace(/\s+/g, ""), 10);
    }
  }
  return { dice, flat };
}

export function rollFormula(formula, { crit = false } = {}) {
  const { dice, flat } = parseFormula(formula);
  const rolls = [];
  let total = flat;
  for (const grp of dice) {
    const count = crit ? grp.n * 2 : grp.n;   // крит удваивает кости, не модификатор
    for (let i = 0; i < count; i++) {
      const v = d(grp.sides);
      rolls.push({ sides: grp.sides, value: v, sign: grp.sign });
      total += v * grp.sign;
    }
  }
  return { total, rolls, flat, formula: crit ? formula + " (крит)" : formula };
}

// d20 с преимуществом/помехой. mode: "normal" | "adv" | "dis"
export function rollD20(modifier = 0, mode = "normal") {
  const a = d(20);
  const b = mode === "normal" ? null : d(20);
  let nat = a;
  if (mode === "adv") nat = Math.max(a, b);
  if (mode === "dis") nat = Math.min(a, b);
  return {
    nat, both: b === null ? [a] : [a, b], mode,
    modifier, total: nat + modifier,
    crit: nat === 20, fumble: nat === 1,
  };
}

export function fmtMod(n) {
  return (n >= 0 ? "+" : "") + n;
}

export function abilityMod(score) {
  return Math.floor((score - 10) / 2);
}

// Короткая запись результата для журнала
export function describe(res) {
  if (res.nat !== undefined) {
    const dice = res.both.length > 1
      ? `d20[${res.both.join(", ")}]→${res.nat}`
      : `d20[${res.nat}]`;
    return `${dice} ${fmtMod(res.modifier)} = ${res.total}`;
  }
  const parts = res.rolls.map((r) => r.value).join(", ");
  return `${res.formula}: [${parts}]${res.flat ? " " + fmtMod(res.flat) : ""} = ${res.total}`;
}
