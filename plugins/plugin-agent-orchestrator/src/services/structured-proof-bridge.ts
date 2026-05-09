/**
 * Structured proof bridge — captures `APP_CREATE_DONE` / `PLUGIN_CREATE_DONE`
 * sentinels emitted by spawned task agents and persists the structured claim
 * onto the owning task's session metadata so the custom validator can
 * cross-check the claim against actual disk state.
 *
 * Sibling to `skill-callback-bridge.ts`. Unlike the skill bridge, this bridge
 * never dispatches anything back into the runtime — it only records the
 * proof and echoes a brief acknowledgement to the PTY so the agent knows
 * the orchestrator saw it.
 *
 * Sentinel grammar (one per session, on its own line):
 *
 *   APP_CREATE_DONE     {"appName":"foo","files":[...],"tests":{"passed":N,"failed":0},"lint":"ok","typecheck":"ok"}
 *   PLUGIN_CREATE_DONE  {"pluginName":"plugin-bar","files":[...],"tests":{"passed":N,"failed":0},"lint":"ok","typecheck":"ok"}
 *
 * @module services/structured-proof-bridge
 */

import type { IAgentRuntime, Logger } from "@elizaos/core";
import type { PTYService } from "./pty-service.js";
import type { TaskRegistry } from "./task-registry.js";

const LOG_PREFIX = "[StructuredProof]";
const LEGACY_PROOF_FIELDS = ["name", "testsPassed", "lintClean"] as const;

const STRUCTURED_PROOF_DIRECTIVE_RE =
  /^[\t ]*(APP_CREATE_DONE|PLUGIN_CREATE_DONE)[\t ]+(\{[\s\S]*?\})[\t ]*$/m;

export type StructuredProofKind = "APP_CREATE_DONE" | "PLUGIN_CREATE_DONE";
export type StructuredProofStatus = "ok";

export interface StructuredProofTests {
  passed: number;
  failed: number;
}

interface BaseStructuredProofClaim {
  /** Kind of completion sentinel emitted by the child. */
  kind: StructuredProofKind;
  /** Relative paths the child claims to have created/modified. Required. */
  files: string[];
  /** Test result summary from the child verification run. */
  tests: StructuredProofTests;
  /** Lint status. Completion proofs only accept "ok". */
  lint: StructuredProofStatus;
  /** Typecheck status. Completion proofs only accept "ok". */
  typecheck: StructuredProofStatus;
  /** Wall-clock timestamp when this proof was recorded. */
  recordedAt: number;
  /** Any other JSON fields the child included. */
  extra?: Record<string, unknown>;
}

export interface AppStructuredProofClaim extends BaseStructuredProofClaim {
  kind: "APP_CREATE_DONE";
  appName: string;
}

export interface PluginStructuredProofClaim extends BaseStructuredProofClaim {
  kind: "PLUGIN_CREATE_DONE";
  pluginName: string;
}

export type StructuredProofClaim =
  | AppStructuredProofClaim
  | PluginStructuredProofClaim;

type ParsedStructuredProof =
  | { kind: "APP_CREATE_DONE"; claim: AppStructuredProofClaim }
  | { kind: "PLUGIN_CREATE_DONE"; claim: PluginStructuredProofClaim };

type StructuredProofLogger = Pick<Logger, "info" | "warn" | "error">;

const NOOP_LOGGER: StructuredProofLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function getLogger(runtime: IAgentRuntime): StructuredProofLogger {
  const candidate = (runtime as { logger?: StructuredProofLogger })
    .logger;
  return candidate ?? NOOP_LOGGER;
}

function isPlainStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOwnField(obj: Record<string, unknown>, field: string): boolean {
  return Object.hasOwn(obj, field);
}

function isNonNegativeInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    Number.isFinite(value) &&
    value >= 0
  );
}

function parseStructuredProofTests(
  value: unknown,
): { ok: true; tests: StructuredProofTests } | { ok: false; reason: string } {
  if (!isPlainObject(value)) {
    return { ok: false, reason: "'tests' must be an object" };
  }
  const passed = value.passed;
  const failed = value.failed;
  if (!isNonNegativeInteger(passed)) {
    return {
      ok: false,
      reason: "'tests.passed' must be a non-negative integer",
    };
  }
  if (!isNonNegativeInteger(failed)) {
    return {
      ok: false,
      reason: "'tests.failed' must be a non-negative integer",
    };
  }
  if (failed !== 0) {
    return { ok: false, reason: "'tests.failed' must be 0" };
  }
  return { ok: true, tests: { passed, failed } };
}

function getNameField(kind: StructuredProofKind): "appName" | "pluginName" {
  return kind === "APP_CREATE_DONE" ? "appName" : "pluginName";
}

function getOppositeNameField(
  kind: StructuredProofKind,
): "appName" | "pluginName" {
  return kind === "APP_CREATE_DONE" ? "pluginName" : "appName";
}

function getStructuredProofName(claim: StructuredProofClaim): string {
  return claim.kind === "APP_CREATE_DONE" ? claim.appName : claim.pluginName;
}

function buildParsedStructuredProof(
  kind: StructuredProofKind,
  canonicalName: string,
  files: string[],
  tests: StructuredProofTests,
  extra: Record<string, unknown> | undefined,
): ParsedStructuredProof {
  const base = {
    files,
    tests,
    lint: "ok" as const,
    typecheck: "ok" as const,
    recordedAt: Date.now(),
    ...(extra ? { extra } : {}),
  };
  if (kind === "APP_CREATE_DONE") {
    return {
      kind,
      claim: {
        kind,
        appName: canonicalName,
        ...base,
      },
    };
  }
  return {
    kind,
    claim: {
      kind,
      pluginName: canonicalName,
      ...base,
    },
  };
}

/**
 * Parse the first APP_CREATE_DONE / PLUGIN_CREATE_DONE directive in a chunk
 * of agent output, if any. The directive must be on its own line (after
 * optional whitespace) and the JSON must include all required fields:
 * `appName`/`pluginName`, `files`, `tests`, `lint`, and `typecheck`.
 * Anything missing returns a structured "invalid" result so the bridge can
 * log without persisting.
 */
export function parseStructuredProofDirective(
  text: string,
):
  | { ok: true; parsed: ParsedStructuredProof }
  | { ok: false; reason: string }
  | null {
  if (!text) return null;
  const match = STRUCTURED_PROOF_DIRECTIVE_RE.exec(text);
  if (!match) return null;
  const kind = match[1] as StructuredProofKind;
  const jsonRaw = match[2];
  let payload: unknown;
  try {
    payload = JSON.parse(jsonRaw);
  } catch (err) {
    return {
      ok: false,
      reason: `JSON parse failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
  if (!isPlainObject(payload)) {
    return { ok: false, reason: "payload must be a JSON object" };
  }
  const obj = payload;
  for (const field of LEGACY_PROOF_FIELDS) {
    if (hasOwnField(obj, field)) {
      return {
        ok: false,
        reason: `field '${field}' is not supported`,
      };
    }
  }
  const nameField = getNameField(kind);
  const oppositeNameField = getOppositeNameField(kind);
  if (hasOwnField(obj, oppositeNameField)) {
    return {
      ok: false,
      reason: `'${oppositeNameField}' is not valid for ${kind}`,
    };
  }
  const rawName = obj[nameField];
  const files = obj.files;
  if (typeof rawName !== "string" || rawName.trim().length === 0) {
    return { ok: false, reason: `missing or empty '${nameField}'` };
  }
  if (!isPlainStringArray(files)) {
    return { ok: false, reason: "'files' must be string[]" };
  }
  const parsedTests = parseStructuredProofTests(obj.tests);
  if (!parsedTests.ok) {
    return parsedTests;
  }
  if (obj.lint !== "ok") {
    return { ok: false, reason: "'lint' must be \"ok\"" };
  }
  if (obj.typecheck !== "ok") {
    return { ok: false, reason: "'typecheck' must be \"ok\"" };
  }
  // Preserve any unknown JSON fields under `extra` so downstream validators
  // can read them without re-parsing the line.
  const known = new Set([nameField, "files", "tests", "lint", "typecheck"]);
  const extra: Record<string, unknown> = {};
  let hasExtra = false;
  for (const [key, value] of Object.entries(obj)) {
    if (known.has(key)) continue;
    extra[key] = value;
    hasExtra = true;
  }
  const parsed = buildParsedStructuredProof(
    kind,
    rawName.trim(),
    files,
    parsedTests.tests,
    hasExtra ? extra : undefined,
  );
  return { ok: true, parsed };
}

interface BridgeDeps {
  runtime: IAgentRuntime;
  ptyService: PTYService;
  /** Optional override for tests / non-default registries. */
  taskRegistry?: TaskRegistry;
}

/**
 * Per-runtime install guard — prevents stacking duplicate listeners when
 * many spawn calls fire concurrently. Mirrors the skill bridge.
 */
const installedRuntimes = new WeakSet<object>();

/**
 * Per-session idempotency: only persist the FIRST structured proof we see
 * for a given session. Subsequent sentinels are logged and skipped so a
 * looping agent cannot rewrite its own claim. Cleared on session teardown
 * (the entry naturally drops at process exit; we do not aggressively GC).
 */
const persistedSessions = new Set<string>();

/**
 * Reset per-session state. Tests use this to assert idempotency cleanly.
 * Production callers can call this when a session is recycled, but the
 * bridge is robust either way — duplicates are just logged.
 */
export function _resetStructuredProofBridge(): void {
  persistedSessions.clear();
}

function resolveTaskRegistry(deps: BridgeDeps): TaskRegistry | null {
  if (deps.taskRegistry) return deps.taskRegistry;
  const coordinator = deps.ptyService.coordinator;
  return coordinator?.taskRegistry ?? null;
}

/**
 * Ensure the bridge is installed exactly once for this runtime+PTY pair.
 * Safe to call from PTYService.start() and from every task spawn.
 */
export function ensureStructuredProofBridge(
  runtime: IAgentRuntime,
  ptyService: PTYService,
): void {
  const runtimeKey = runtime as object;
  if (installedRuntimes.has(runtimeKey)) return;
  installedRuntimes.add(runtimeKey);
  installStructuredProofBridge({ runtime, ptyService });
}

/**
 * Install the structured-proof bridge. Returns a teardown function. Safe to
 * call multiple times — the caller is responsible for deduplication via
 * `ensureStructuredProofBridge` (or by tracking the returned teardown).
 */
export function installStructuredProofBridge(deps: BridgeDeps): () => void {
  const { runtime, ptyService } = deps;
  const log = getLogger(runtime);

  const recordProof = async (
    sessionId: string,
    parsed: ParsedStructuredProof,
  ): Promise<void> => {
    const proofName = getStructuredProofName(parsed.claim);
    if (persistedSessions.has(sessionId)) {
      log.info?.(
        `${LOG_PREFIX} duplicate ${parsed.kind} for session ${sessionId} (name=${proofName}); skipping`,
      );
      // Echo back so the agent doesn't think the orchestrator missed it,
      // but make it explicit that this is a duplicate.
      await ptyService.sendToSession(
        sessionId,
        `--- structured proof duplicate ignored (${parsed.kind}, ${proofName}) ---`,
      );
      return;
    }

    const registry = resolveTaskRegistry(deps);
    if (!registry) {
      log.warn?.(
        `${LOG_PREFIX} no task registry available; cannot persist proof for session ${sessionId}`,
      );
      return;
    }

    // Mark as persisted BEFORE the await so concurrent sentinels in the
    // same buffer chunk don't both win the idempotency check.
    persistedSessions.add(sessionId);

    await registry.updateSession(sessionId, {
      metadata: {
        structuredProof: parsed.claim,
      },
    });
    log.info?.(
      `${LOG_PREFIX} recorded ${parsed.kind} for session ${sessionId} ` +
        `(name=${proofName}, files=${parsed.claim.files.length}, ` +
        `tests.passed=${parsed.claim.tests.passed}, ` +
        `tests.failed=${parsed.claim.tests.failed}, ` +
        `lint=${parsed.claim.lint}, typecheck=${parsed.claim.typecheck})`,
    );
    await ptyService.sendToSession(
      sessionId,
      `--- structured proof recorded (${parsed.kind}, ${proofName}) ---`,
    );
  };

  const unsubscribe = ptyService.onSessionEvent((sessionId, event, data) => {
    if (event !== "task_complete" && event !== "message") return;
    const responseText =
      typeof (data as { response?: unknown })?.response === "string"
        ? (data as { response: string }).response
        : typeof (data as { text?: unknown })?.text === "string"
          ? (data as { text: string }).text
          : "";
    const parseResult = parseStructuredProofDirective(responseText);
    if (!parseResult) return;
    if (!parseResult.ok) {
      log.warn?.(
        `${LOG_PREFIX} session ${sessionId} emitted malformed structured proof: ${parseResult.reason}`,
      );
      return;
    }

    void recordProof(sessionId, parseResult.parsed).catch((err) => {
      // Roll back the idempotency mark on failure so a retry can succeed.
      persistedSessions.delete(sessionId);
      log.error?.(
        `${LOG_PREFIX} failed to persist proof for session ${sessionId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
  });

  log.info?.(`${LOG_PREFIX} structured-proof bridge installed`);

  return () => {
    if (typeof unsubscribe === "function") unsubscribe();
  };
}
