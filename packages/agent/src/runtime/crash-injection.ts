/**
 * Crash / hang fault injection for the agent stability matrix (issue #10203).
 *
 * A dev/test-only hook that lets the crash-restart e2e suite deterministically
 * fault the agent at named lifecycle points and assert the supervisor recovers
 * (or reports) as designed. It is **disarmed by default** and **refuses to arm
 * in production** unless the operator explicitly opts in, because an armed crash
 * hook in prod is itself an availability vulnerability.
 *
 * Arm it with `ELIZA_CRASH_INJECT="<point>:<mode>[:<arg>],..."`, e.g.
 *   ELIZA_CRASH_INJECT="boot:exit"            → exit(1) during boot
 *   ELIZA_CRASH_INJECT="steady:throw"         → throw at steady state
 *   ELIZA_CRASH_INJECT="plugin-load:reject"   → unhandled rejection on plugin load
 *   ELIZA_CRASH_INJECT="model-load:hang:5000" → hang model load for 5s
 *   ELIZA_CRASH_INJECT="native-bridge:restart"→ request a clean restart
 *   ELIZA_CRASH_INJECT="steady:oom:200"       → grow heap by ~200MB chunks
 *
 * Logging deliberately uses `process.stderr` rather than the core logger: a
 * `boot` fault fires before the logger is initialized, and the e2e stub child
 * runs without booting `@elizaos/core`. Keeping this module dependency-light is
 * what makes it usable from a minimal supervised child.
 *
 * @module crash-injection
 */
import process from "node:process";
import { RESTART_EXIT_CODE } from "@elizaos/shared/restart";

export { RESTART_EXIT_CODE };

/** Lifecycle points an injected fault can target. Keep in sync with the matrix. */
export const CRASH_INJECTION_POINTS = [
  "boot",
  "ready",
  "steady",
  "plugin-load",
  "model-load",
  "native-bridge",
  "message",
  "voice",
] as const;
export type CrashInjectionPoint = (typeof CRASH_INJECTION_POINTS)[number];

/** How an injected fault manifests. */
export const CRASH_INJECTION_MODES = [
  /** Hard, uncontrolled exit (simulates a fatal crash). */
  "exit",
  /** Throw synchronously at the call site (simulates an unguarded bug). */
  "throw",
  /** Schedule an unhandled promise rejection (simulates an async leak). */
  "reject",
  /** Block for `arg` ms (or indefinitely) — simulates a hang. */
  "hang",
  /** Grow the heap in `arg`-MB chunks — simulates memory pressure / OOM. */
  "oom",
  /** Request a clean supervised restart (exit `RESTART_EXIT_CODE`). */
  "restart",
] as const;
export type CrashInjectionMode = (typeof CRASH_INJECTION_MODES)[number];

export interface CrashInjectionFault {
  mode: CrashInjectionMode;
  /** Numeric argument: exit code (exit), hang ms (hang), chunk MB (oom). */
  arg?: number;
}

export type CrashInjectionConfig = Map<
  CrashInjectionPoint,
  CrashInjectionFault
>;

const ENV_SPEC = "ELIZA_CRASH_INJECT";
const ENV_ALLOW_PROD = "ELIZA_ALLOW_CRASH_INJECT";

function isPoint(value: string): value is CrashInjectionPoint {
  return (CRASH_INJECTION_POINTS as readonly string[]).includes(value);
}
function isMode(value: string): value is CrashInjectionMode {
  return (CRASH_INJECTION_MODES as readonly string[]).includes(value);
}

function warn(message: string): void {
  // stderr, not the logger — see module docstring.
  try {
    process.stderr.write(`[crash-injection] ${message}\n`);
  } catch {
    // never let logging throw inside a fault hook
  }
}

/**
 * Parse an `ELIZA_CRASH_INJECT` spec into a validated config. Pure + total:
 * invalid points/modes are skipped with a warning rather than thrown, so a typo
 * can never crash boot through the very hook meant to test crashes.
 */
export function parseCrashInjectionSpec(
  raw: string | undefined,
): CrashInjectionConfig {
  const config: CrashInjectionConfig = new Map();
  if (!raw?.trim()) return config;

  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const [pointRaw, modeRaw, argRaw] = trimmed.split(":").map((s) => s.trim());
    if (!isPoint(pointRaw)) {
      warn(`ignoring unknown injection point "${pointRaw}"`);
      continue;
    }
    const mode = modeRaw && isMode(modeRaw) ? modeRaw : "exit";
    if (modeRaw && !isMode(modeRaw)) {
      warn(`unknown mode "${modeRaw}" for "${pointRaw}", defaulting to exit`);
    }
    const argNum = argRaw !== undefined ? Number(argRaw) : undefined;
    const arg =
      argNum !== undefined && Number.isFinite(argNum) ? argNum : undefined;
    config.set(pointRaw, { mode, arg });
  }
  return config;
}

/** True when the running process is a production runtime (no fault hooks). */
function isProductionRuntime(env: NodeJS.ProcessEnv): boolean {
  return (
    env.NODE_ENV === "production" || env.ELIZA_BUILD_VARIANT === "production"
  );
}

/**
 * Resolve the active config from the environment, enforcing the production
 * safety gate. Returns an empty config (disarmed) unless `ELIZA_CRASH_INJECT`
 * is set AND (the runtime is non-production OR `ELIZA_ALLOW_CRASH_INJECT=1`).
 */
export function resolveCrashInjectionConfig(
  env: NodeJS.ProcessEnv = process.env,
): CrashInjectionConfig {
  const spec = env[ENV_SPEC];
  if (!spec?.trim()) return new Map();
  if (isProductionRuntime(env) && env[ENV_ALLOW_PROD] !== "1") {
    warn(
      `${ENV_SPEC} is set in a production runtime but ${ENV_ALLOW_PROD} != 1 — refusing to arm fault injection.`,
    );
    return new Map();
  }
  return parseCrashInjectionSpec(spec);
}

let armed: CrashInjectionConfig | null = null;
const tripped = new Set<CrashInjectionPoint>();

/**
 * Arm fault injection from the environment once at process start. Idempotent.
 * Logs the armed plan loudly so an armed test build is never silent. Returns the
 * resolved (possibly empty) config.
 */
export function armCrashInjection(
  env: NodeJS.ProcessEnv = process.env,
): CrashInjectionConfig {
  armed = resolveCrashInjectionConfig(env);
  if (armed.size > 0) {
    const plan = [...armed.entries()]
      .map(
        ([p, f]) => `${p}=${f.mode}${f.arg !== undefined ? `:${f.arg}` : ""}`,
      )
      .join(", ");
    warn(`ARMED (test/dev fault injection): ${plan}`);
  }
  return armed;
}

/** True when any fault is armed. */
export function isCrashInjectionArmed(): boolean {
  return (armed ?? new Map()).size > 0;
}

function executeFault(
  point: CrashInjectionPoint,
  fault: CrashInjectionFault,
): void {
  warn(`injecting ${fault.mode} at "${point}"`);
  switch (fault.mode) {
    case "exit":
      process.exit(Number.isFinite(fault.arg) ? (fault.arg as number) : 1);
      break;
    case "restart":
      process.exit(RESTART_EXIT_CODE);
      break;
    case "throw":
      throw new Error(`[crash-injection] injected throw at "${point}"`);
    case "reject":
      // A real unhandled rejection: not awaited, not caught.
      Promise.reject(
        new Error(
          `[crash-injection] injected unhandled rejection at "${point}"`,
        ),
      );
      break;
    case "oom": {
      const chunkMb = Number.isFinite(fault.arg) ? (fault.arg as number) : 100;
      const sink: Uint8Array[] = [];
      // Grow until the runtime kills the process with an allocation failure.
      // Bounded only by available memory — this is the point.
      for (;;) {
        sink.push(new Uint8Array(chunkMb * 1024 * 1024).fill(1));
      }
    }
    default:
      break;
  }
}

/**
 * Fire any fault armed for `point`. No-op when disarmed or already tripped for
 * that point (a point fires at most once so a `hang`/`reject` can't storm). For
 * `hang` this returns a promise the caller should `await`; every other mode
 * either does not return (exit/restart), throws, or returns after scheduling.
 */
export function maybeInjectFault(
  point: CrashInjectionPoint,
): undefined | Promise<never> {
  if (armed === null) armCrashInjection();
  const fault = armed?.get(point);
  if (!fault || tripped.has(point)) return;
  tripped.add(point);

  if (fault.mode === "hang") {
    const ms = Number.isFinite(fault.arg) ? (fault.arg as number) : undefined;
    warn(
      `injecting hang at "${point}"${ms ? ` for ${ms}ms` : " (indefinite)"}`,
    );
    return new Promise<never>(() => {
      // never resolves; if ms given, the timer keeps the event loop busy but
      // the awaiting path stays blocked — that is the hang we are simulating.
      if (ms) setTimeout(() => {}, ms);
    });
  }
  executeFault(point, fault);
}

/** Test-only: clear armed state + trip history so suites don't leak into each other. */
export function resetCrashInjectionForTests(): void {
  armed = null;
  tripped.clear();
}
