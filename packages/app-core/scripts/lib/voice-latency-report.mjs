/**
 * Render an end-to-end voice-latency payload (`GET /api/dev/voice-latency`)
 * as a human-readable table. Used by
 * `eliza/packages/app-core/scripts/voice-latency-report.mjs` and its test.
 *
 * The payload shape is the `VoiceLatencyDevPayload` from
 * `packages/app-core/src/services/local-inference/latency-trace.ts`:
 *   { generatedAtEpochMs, checkpoints[], derivedKeys[], openTurnCount,
 *     traces: LatencyTrace[], histograms: Record<key, HistogramSummary> }
 *
 * Null fields (a checkpoint that never fired, a histogram with no samples)
 * print as `—` — never as 0 (a missing measurement is not a zero one).
 */

const DASH = "—";

function fmtMs(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return DASH;
  }
  return `${Math.round(value)}ms`;
}

function pad(text, width) {
  const s = String(text);
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function padLeft(text, width) {
  const s = String(text);
  return s.length >= width ? s : " ".repeat(width - s.length) + s;
}

/**
 * @param {object} payload The VoiceLatencyDevPayload-shaped object.
 * @param {object} [opts]
 * @param {number} [opts.maxTraces] Max recent traces to render (default 10).
 * @returns {string} The rendered report.
 */
export function renderVoiceLatencyReport(payload, opts = {}) {
  const maxTraces =
    Number.isInteger(opts.maxTraces) && opts.maxTraces > 0
      ? opts.maxTraces
      : 10;
  const lines = [];
  const traces = Array.isArray(payload?.traces) ? payload.traces : [];
  const histograms =
    payload && typeof payload.histograms === "object" && payload.histograms
      ? payload.histograms
      : {};
  const derivedKeys = Array.isArray(payload?.derivedKeys)
    ? payload.derivedKeys
    : Object.keys(histograms);

  const generatedAt = Number.isFinite(payload?.generatedAtEpochMs)
    ? new Date(payload.generatedAtEpochMs).toISOString()
    : "unknown";
  lines.push(
    `Voice latency — ${traces.length} trace(s), generatedAt=${generatedAt}`,
  );
  if (Number.isFinite(payload?.openTurnCount)) {
    lines.push(`open turns: ${payload.openTurnCount}`);
  }
  lines.push("");

  // ── Histogram table ──────────────────────────────────────────────────
  lines.push("Per-stage histograms (over retained samples):");
  const keyWidth = Math.max(6, ...derivedKeys.map((k) => k.length));
  lines.push(
    `  ${pad("metric", keyWidth)}  ${padLeft("n", 5)}  ${padLeft("p50", 9)}  ${padLeft("p90", 9)}  ${padLeft("p99", 9)}  ${padLeft("min", 9)}  ${padLeft("max", 9)}  ${padLeft("mean", 9)}`,
  );
  for (const key of derivedKeys) {
    const h = histograms[key] ?? {};
    lines.push(
      `  ${pad(key, keyWidth)}  ${padLeft(Number.isFinite(h.count) ? h.count : 0, 5)}  ${padLeft(fmtMs(h.p50), 9)}  ${padLeft(fmtMs(h.p90), 9)}  ${padLeft(fmtMs(h.p99), 9)}  ${padLeft(fmtMs(h.min), 9)}  ${padLeft(fmtMs(h.max), 9)}  ${padLeft(fmtMs(h.mean), 9)}`,
    );
  }
  lines.push("");

  // ── Recent traces ────────────────────────────────────────────────────
  if (traces.length === 0) {
    lines.push("No traces recorded yet.");
    return lines.join("\n");
  }
  const recent = traces.slice(Math.max(0, traces.length - maxTraces));
  lines.push(`Recent traces (last ${recent.length}):`);
  for (const t of recent) {
    const flag = t?.complete ? "" : " [incomplete]";
    const room = t?.roomId ? ` room=${t.roomId}` : "";
    const ttft = fmtMs(t?.derived?.ttftMs);
    const ttfa = fmtMs(t?.derived?.ttfaMs);
    const ttap = fmtMs(t?.derived?.ttapMs);
    lines.push(
      `  ${t?.turnId ?? "?"}${room}${flag}  ttft=${ttft} ttfa=${ttfa} ttap=${ttap}`,
    );
    const missing = Array.isArray(t?.missing) ? t.missing : [];
    if (missing.length > 0) {
      lines.push(`    missing: ${missing.join(", ")}`);
    }
    const anomalies = Array.isArray(t?.anomalies) ? t.anomalies : [];
    for (const a of anomalies) {
      lines.push(`    anomaly: ${a}`);
    }
  }
  return lines.join("\n");
}

/**
 * Fetch the voice-latency payload from a running API and render it.
 * Returns `{ ok, status, report, error? }`. Never throws — a fetch failure
 * is surfaced in the result.
 *
 * @param {string} baseUrl e.g. "http://127.0.0.1:31337"
 * @param {object} [opts]
 * @param {number} [opts.limit] `?limit=` on the request.
 * @param {number} [opts.timeoutMs] default 2500.
 * @param {typeof fetch} [opts.fetchImpl]
 */
export async function fetchAndRenderVoiceLatency(baseUrl, opts = {}) {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 2500;
  const url = new URL("/api/dev/voice-latency", baseUrl);
  if (Number.isInteger(opts.limit) && opts.limit > 0) {
    url.searchParams.set("limit", String(opts.limit));
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url.toString(), { signal: controller.signal });
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        report: "",
        error: `HTTP ${res.status} from ${url.pathname}`,
      };
    }
    const payload = await res.json();
    return {
      ok: true,
      status: res.status,
      report: renderVoiceLatencyReport(payload, { maxTraces: opts.maxTraces }),
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      report: "",
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}
