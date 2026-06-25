/**
 * Renderer startup telemetry (issue #9565).
 *
 * A tiny, dependency-free recorder for cold-start `performance.mark()`s on the
 * renderer side of a device boot. It does NOT drive startup — the sole startup
 * authority stays `useStartupCoordinator`; this only OBSERVES the boot so a
 * single device launch can be reconstructed (a harness reads
 * `window.__ELIZA_STARTUP_TRACE__`) and correlated with the native host trace
 * (Electrobun `startup-trace.ts`) and backend boot telemetry
 * (`<stateDir>/telemetry/boot/latest.json`) through one shared trace id.
 *
 * Each checkpoint is recorded once (first occurrence wins — boot phases are
 * one-shot), emitted as a real `performance.mark()` (so it shows in the
 * Performance panel and `performance.getEntriesByType("mark")`), and mirrored
 * onto `window.__ELIZA_STARTUP_TRACE__` for out-of-band capture.
 */

export interface StartupMark {
  /** Canonical checkpoint name (e.g. "module-eval", "coordinator:ready"). */
  name: string;
  /** Milliseconds since `performance.timeOrigin` (the renderer's t0). */
  at: number;
  /** Optional structured detail (phase, target, plugin counts, …). */
  detail?: Record<string, unknown>;
}

export interface StartupTrace {
  /** Shared id used to correlate renderer ↔ native host ↔ backend boot. */
  traceId: string;
  /** `performance.timeOrigin` (epoch ms of t0) for cross-process alignment. */
  timeOrigin: number;
  /** Recorded checkpoints, in arrival order. */
  marks: StartupMark[];
}

/** `performance.mark()` name prefix so renderer marks are greppable. */
export const STARTUP_MARK_PREFIX = "eliza.startup:";
/** Window key the harness reads. */
export const STARTUP_TRACE_WINDOW_KEY = "__ELIZA_STARTUP_TRACE__";
/** Window key a native host (Electrobun/Capacitor) may inject to share its id. */
export const STARTUP_TRACE_ID_WINDOW_KEY = "__ELIZA_STARTUP_TRACE_ID__";

declare global {
  interface Window {
    /** Renderer startup trace mirrored for out-of-band harness capture. */
    [STARTUP_TRACE_WINDOW_KEY]?: StartupTrace;
    /** Native-host-injected trace id, shared across host ↔ renderer. */
    [STARTUP_TRACE_ID_WINDOW_KEY]?: string;
  }
}

// One boot == one module evaluation, so module-level state is the trace.
let traceId = "";
const marks: StartupMark[] = [];
const recorded = new Set<string>();

function nowMs(): number {
  return typeof performance !== "undefined" &&
    typeof performance.now === "function"
    ? performance.now()
    : 0;
}

function originMs(): number {
  return typeof performance !== "undefined" &&
    typeof performance.timeOrigin === "number"
    ? performance.timeOrigin
    : 0;
}

function readInjectedTraceId(): string | undefined {
  if (typeof window === "undefined") return undefined;
  const value = window[STARTUP_TRACE_ID_WINDOW_KEY];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function mirrorToWindow(): void {
  if (typeof window === "undefined") return;
  window[STARTUP_TRACE_WINDOW_KEY] = {
    traceId,
    timeOrigin: originMs(),
    marks,
  } satisfies StartupTrace;
}

/**
 * Resolve the trace id once. A native-host-injected id wins (so a desktop or
 * mobile launch shares ONE id across the native trace + this renderer trace);
 * otherwise the caller's `preferredId` is used; otherwise a renderer-local id
 * derived from `timeOrigin` (stable across a single boot, no RNG/clock so the
 * UI determinism gate stays green). Idempotent.
 */
export function initStartupTrace(preferredId?: string): string {
  if (traceId) return traceId;
  traceId =
    readInjectedTraceId() ??
    preferredId ??
    `renderer-${Math.trunc(originMs())}`;
  mirrorToWindow();
  return traceId;
}

/**
 * Record a startup checkpoint. First call for a given `name` wins; later calls
 * are ignored so phase re-entry (poll retries, agent switching) does not skew
 * the cold-start story. Cheap and safe to call from the boot critical path.
 */
export function markStartup(
  name: string,
  detail?: Record<string, unknown>,
): void {
  if (recorded.has(name)) return;
  recorded.add(name);
  if (!traceId) initStartupTrace();

  const mark: StartupMark = { name, at: nowMs() };
  if (detail) mark.detail = detail;
  marks.push(mark);

  if (
    typeof performance !== "undefined" &&
    typeof performance.mark === "function"
  ) {
    try {
      performance.mark(`${STARTUP_MARK_PREFIX}${name}`, {
        detail: { traceId, ...detail },
      });
    } catch {
      // Some engines reject the options bag; the plain mark is enough.
      performance.mark(`${STARTUP_MARK_PREFIX}${name}`);
    }
  }

  mirrorToWindow();
}

/**
 * Emit a `performance.measure()` spanning two recorded checkpoints, so a span
 * (e.g. how long `initializeAppModules` blocked first paint) is visible in the
 * Performance panel. No-op if either mark is missing.
 */
export function measureStartup(
  name: string,
  fromName: string,
  toName?: string,
): void {
  if (
    typeof performance === "undefined" ||
    typeof performance.measure !== "function"
  ) {
    return;
  }
  try {
    const options: PerformanceMeasureOptions = {
      start: `${STARTUP_MARK_PREFIX}${fromName}`,
    };
    if (toName) options.end = `${STARTUP_MARK_PREFIX}${toName}`;
    performance.measure(`${STARTUP_MARK_PREFIX}${name}`, options);
  } catch {
    // A missing endpoint mark is expected on paths that short-circuit boot.
  }
}

/** Snapshot of the current trace (clones the marks array). */
export function getStartupTrace(): StartupTrace {
  return { traceId, timeOrigin: originMs(), marks: marks.slice() };
}

/** True once a given checkpoint has been recorded. */
export function hasStartupMark(name: string): boolean {
  return recorded.has(name);
}

/** Test-only reset of module state. */
export function __resetStartupTraceForTests(): void {
  traceId = "";
  marks.length = 0;
  recorded.clear();
  if (typeof window !== "undefined") {
    delete window[STARTUP_TRACE_WINDOW_KEY];
    delete window[STARTUP_TRACE_ID_WINDOW_KEY];
  }
}
