/** Evidence checks for one isolated smoke chat, bounded by its log snapshots. */
export function inspectSmokeResponse(body) {
  const text =
    body?.choices?.[0]?.message?.content ?? body?.choices?.[0]?.delta?.content;
  if (body?.error || typeof text !== "string" || !text.trim()) {
    return { ok: false, reason: "Missing successful chat content" };
  }
  if (
    text.trim() ===
    "Something went wrong before I could answer. Try again in a moment."
  ) {
    return {
      ok: false,
      reason: "Chat returned the runtime's canned failure reply",
    };
  }
  return { ok: true, text };
}

export function inspectFreshLocalGeneration(before, after) {
  if (
    typeof before !== "string" ||
    typeof after !== "string" ||
    !after.startsWith(before)
  ) {
    return {
      ok: false,
      reason: "Agent log changed or rotated during the request",
    };
  }
  const fresh = after.slice(before.length);
  const bionic = [
    ...fresh.matchAll(
      /\[mobile-device-bridge\] bionic GPU generate: ([0-9]+) tok @ ([0-9]+(?:\.[0-9]+)?) tok\/s/g,
    ),
  ].filter((m) => Number(m[1]) > 0 && Number(m[2]) > 0);
  const ffi = [...fresh.matchAll(/\[aosp-llama\] gen done\b/g)];
  if (bionic.length + ffi.length === 0) {
    return {
      ok: false,
      reason: "No fresh completed local generation in the request interval",
    };
  }
  return {
    ok: true,
    bionicCompletions: bionic.length,
    ffiCompletions: ffi.length,
  };
}

/** Match a complete native reply to a generation started in this request window. */
export function inspectFreshNativeGeneration({
  before,
  after,
  pidBefore,
  pidAfter,
  responseText,
}) {
  if (!/^\d+$/.test(pidBefore) || pidAfter !== pidBefore) {
    return {
      ok: false,
      reason: "Native inference process changed during the request",
    };
  }
  if (
    typeof before !== "string" ||
    typeof after !== "string" ||
    !after.startsWith(before)
  ) {
    return {
      ok: false,
      reason: "Native log changed or rotated during the request",
    };
  }
  const started = new Set();
  let completions = 0;
  for (const line of after.slice(before.length).split("\n")) {
    const entry = line.match(
      /^\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+\s+(\d+)\s+(\d+)\s+[VDIWEF]\s+ElizaBionicInfer:\s+(.*)$/,
    );
    if (!entry || entry[1] !== pidBefore) continue;
    const [, , thread, message] = entry;
    if (message.startsWith("GENERATE from agent:")) {
      started.add(thread);
      continue;
    }
    const result = message.match(
      /^GENERATE result(?: \(resident\))?: (\{.*\})$/,
    );
    if (!result || !started.delete(thread)) continue;
    let body;
    try {
      body = JSON.parse(result[1]);
    } catch {
      continue;
    }
    if (
      body.ok === true &&
      Number.isInteger(body.tokens) &&
      body.tokens > 0 &&
      Number.isFinite(body.ms) &&
      body.ms > 0 &&
      body.incomplete === false &&
      typeof body.text === "string" &&
      body.text.trim() &&
      typeof responseText === "string" &&
      body.text.trim() === responseText.trim()
    ) {
      completions++;
    }
  }
  return completions > 0
    ? { ok: true, bionicCompletions: completions, ffiCompletions: 0 }
    : {
        ok: false,
        reason: "No fresh native generation matches the returned reply",
      };
}
