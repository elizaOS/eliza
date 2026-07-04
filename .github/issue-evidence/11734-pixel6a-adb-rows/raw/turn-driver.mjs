#!/usr/bin/env bun
// turn-driver.mjs — single streaming turn against the on-device API
// (adb forward tcp:31337) for #11734 TTFT/prefill capture.
// Measures, from the client side:
//   ttfbMs  — time to first HTTP response byte (headers+first chunk)
//   ttftMs  — time to first SSE delta carrying non-empty content (client TTFT)
//   totalMs — time to stream end
// Writes one JSON line to stdout; raw SSE transcript to argv[3] if given.
const q = process.argv[2];
const rawOut = process.argv[3];
const label = process.argv[4] ?? "";
if (!q) {
  console.error("usage: turn-driver.mjs <question> [raw-sse-out] [label]");
  process.exit(2);
}
const body = JSON.stringify({
  model: "eliza",
  stream: true,
  max_tokens: 20,
  messages: [{ role: "user", content: q }],
});
const t0 = performance.now();
const epoch0 = Date.now();
const res = await fetch("http://127.0.0.1:31337/v1/chat/completions", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body,
  signal: AbortSignal.timeout(480_000),
});
let ttfbMs = null;
let ttftMs = null;
let firstContent = "";
let text = "";
let chunkEvents = 0;
let raw = "";
const decoder = new TextDecoder();
const reader = res.body.getReader();
let buf = "";
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  const now = performance.now();
  if (ttfbMs === null) ttfbMs = now - t0;
  const s = decoder.decode(value, { stream: true });
  raw += `\n--- chunk @${(now - t0).toFixed(0)}ms ---\n${s}`;
  buf += s;
  let idx;
  while ((idx = buf.indexOf("\n\n")) >= 0) {
    const event = buf.slice(0, idx);
    buf = buf.slice(idx + 2);
    for (const line of event.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") continue;
      try {
        const j = JSON.parse(payload);
        const delta = j.choices?.[0]?.delta?.content ?? "";
        if (delta) {
          chunkEvents += 1;
          text += delta;
          if (ttftMs === null) {
            ttftMs = now - t0;
            firstContent = delta;
          }
        }
      } catch {
        /* non-JSON data line — kept in raw transcript */
      }
    }
  }
}
const totalMs = performance.now() - t0;
if (rawOut) await Bun.write(rawOut, raw);
console.log(
  JSON.stringify({
    label,
    epoch0,
    status: res.status,
    contentType: res.headers.get("content-type"),
    qChars: q.length,
    ttfbMs: ttfbMs === null ? null : Math.round(ttfbMs),
    ttftMs: ttftMs === null ? null : Math.round(ttftMs),
    totalMs: Math.round(totalMs),
    chunkEvents,
    firstContent,
    text,
  }),
);
