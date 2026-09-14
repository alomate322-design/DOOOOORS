// Звуки замка. Синтезируются на месте через WebAudio: не нужны файлы, лицензии
// и загрузка с чужих серверов, а звучат короче и тише любого готового сэмпла.

let ctx = null;

function audio() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  return ctx;
}

function tone({ freq, to, start, dur, type = "triangle", gain = 0.12 }) {
  const c = audio();
  if (!c) return;
  const t0 = c.currentTime + start;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (to) osc.frequency.exponentialRampToValueAtTime(to, t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(c.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

function noise({ start, dur, gain = 0.09, cutoff = 900 }) {
  const c = audio();
  if (!c) return;
  const frames = Math.floor(c.sampleRate * dur);
  const buf = c.createBuffer(1, frames, c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < frames; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / frames);
  const src = c.createBufferSource();
  src.buffer = buf;
  const lp = c.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = cutoff;
  const g = c.createGain();
  g.gain.value = gain;
  src.connect(lp).connect(g).connect(c.destination);
  src.start(c.currentTime + start);
}

// Замок поддался: два щелчка и короткий скрип петель.
export function playUnlock() {
  tone({ freq: 880, to: 1320, start: 0, dur: 0.06, gain: 0.1 });
  tone({ freq: 1200, to: 1600, start: 0.08, dur: 0.05, gain: 0.08 });
  tone({ freq: 320, to: 180, start: 0.16, dur: 0.28, type: "sawtooth", gain: 0.05 });
}

// Не поддалось: глухой удар в дерево.
export function playFail() {
  tone({ freq: 150, to: 70, start: 0, dur: 0.16, type: "sine", gain: 0.14 });
  noise({ start: 0, dur: 0.14, gain: 0.07, cutoff: 500 });
}

// Дверь закрыли.
export function playClose() {
  tone({ freq: 260, to: 120, start: 0, dur: 0.12, type: "sine", gain: 0.1 });
  noise({ start: 0.02, dur: 0.1, gain: 0.05, cutoff: 700 });
}

// Бросок кости — короткое постукивание перед результатом.
export function playRoll() {
  for (let i = 0; i < 4; i++) {
    noise({ start: i * 0.045, dur: 0.035, gain: 0.05, cutoff: 2200 });
  }
}
