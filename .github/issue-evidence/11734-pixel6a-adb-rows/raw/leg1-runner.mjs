#!/usr/bin/env bun
// leg1-runner.mjs — #11734 leg 1: TTFT distribution (12 identical-length warm
// turns) + isolated-prefill sweep (8 varied-length turns) against the Pixel 6a
// bionic host through adb forward tcp:31337. Each turn:
//   - drops a logcat marker (adb shell log -t Bench11734)
//   - runs turn-driver.mjs (streaming; client TTFT = first SSE content chunk)
//   - appends one JSON line to the leg's .jsonl
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";

const RAW = import.meta.dir;
const SERIAL = "27051JEGR10034";

const DENY =
  /\b(check|search|find|fetch|get|look\s+up|browse|open|click|call|email|send|create|update|delete|save|remember|schedule|remind|set|run|execute|install|download|upload|read|inspect|build|deploy|commit|push|pull|merge|rebase|book|pay|buy|order)\b/i;
const CURRENT =
  /\b(latest|current|today|tomorrow|yesterday|weather|price|calendar|email|file|repo|repository|log|logs|issue|issues|pr|pull\s+request|wallet|transaction|account|contact|contacts)\b/i;

// --- leg 1a: 12 identical-length questions (two-digit math => same length) ---
const pairs = [
  [12, 34], [45, 27], [88, 19], [23, 45], [56, 21], [74, 13],
  [62, 35], [41, 52], [33, 66], [87, 11], [29, 58], [64, 27],
];
const ttftQs = pairs.map(
  ([a, b]) => `Reply in one short sentence: what is ${a} plus ${b}?`,
);
const lens = new Set(ttftQs.map((q) => q.length));
if (lens.size !== 1) throw new Error(`unequal lengths: ${[...lens]}`);
for (const q of ttftQs) {
  if (DENY.test(q) || CURRENT.test(q)) throw new Error(`deny-pattern hit: ${q}`);
}
console.log(`leg1a: ${ttftQs.length} identical questions of ${ttftQs[0].length} chars`);

// --- leg 1b: 8 varied-length prompts (user text <= 695 chars fast-path cap) ---
const fillerPool = [
  "A calm river flows past green hills beneath a pale sky.",
  "Tall trees sway gently while soft clouds drift far above the quiet valley.",
  "Small birds sing near the old stone bridge as warm light falls on the meadow.",
  "The narrow path winds between mossy rocks toward a silent mountain lake.",
];
function fillerOfLength(target) {
  let s = "";
  let i = 0;
  while (s.length < target) {
    s += (s ? " " : "") + fillerPool[i % fillerPool.length];
    i += 1;
  }
  return s.slice(0, target).replace(/\s+\S*$/, ""); // cut at a word boundary
}
const tailQ = "Reply in one short sentence: what is 40 plus 25?";
const targets = [0, 90, 180, 270, 360, 450, 540, 630];
const prefillQs = targets.map((t) => {
  const f = fillerOfLength(t);
  const q = f ? `${f} ${tailQ}` : tailQ;
  if (q.length > 695) throw new Error(`too long for fast path: ${q.length}`);
  if (DENY.test(q) || CURRENT.test(q)) throw new Error(`deny-pattern hit: ${q}`);
  return q;
});
console.log(`leg1b lengths: ${prefillQs.map((q) => q.length).join(", ")}`);

function marker(msg) {
  spawnSync("adb", ["-s", SERIAL, "shell", "log", "-t", "Bench11734", msg]);
}

function runTurn(q, label, outJsonl) {
  marker(`TURN ${label} start qChars=${q.length}`);
  const r = spawnSync("bun", [`${RAW}/turn-driver.mjs`, q, "", label], {
    timeout: 480_000,
    encoding: "utf8",
  });
  const line = (r.stdout ?? "").trim();
  marker(`TURN ${label} done`);
  if (!line) {
    const err = JSON.stringify({ label, error: r.stderr?.slice(0, 400) ?? "no output" });
    appendFileSync(outJsonl, `${err}\n`);
    console.log(err);
    return;
  }
  appendFileSync(outJsonl, `${line}\n`);
  console.log(line);
}

const leg = process.argv[2];
if (leg === "ttft") {
  ttftQs.forEach((q, i) => {
    runTurn(q, `ttft-${i + 1}`, `${RAW}/ttft-runs.jsonl`);
    Bun.sleepSync(2000);
  });
} else if (leg === "prefill") {
  prefillQs.forEach((q, i) => {
    runTurn(q, `prefill-${i + 1}-len${q.length}`, `${RAW}/prefill-runs.jsonl`);
    Bun.sleepSync(2000);
  });
} else if (leg === "print") {
  console.log(JSON.stringify({ ttftQs, prefillQs }, null, 2));
} else {
  console.error("usage: leg1-runner.mjs ttft|prefill|print");
  process.exit(2);
}
