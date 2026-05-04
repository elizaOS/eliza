/**
 * Spawn-side wiring contract for `PTYService.spawnSession` model preferences.
 *
 * Locks in the centralized model-pref resolution that threads runtime
 * settings (PARALLAX_*_MODEL_POWERFUL/FAST) into the SpawnConfig handed
 * to `manager.spawn(...)` and into the per-session metadata map.
 *
 * Regression context: a merge resolution dropped the
 *   `getTaskAgentModelPrefs(runtime, agentType, readTaskAgentModelPrefs(...))`
 * call inside spawnSession, neutralizing env-only model overrides for
 * spawned coding agents. The helper-level test in
 * `task-agent-frameworks.test.ts` covers `getTaskAgentModelPrefs` in
 * isolation but never exercised the spawn pipe — this file does.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IAgentRuntime } from "@elizaos/core";
import type { SpawnConfig, WorkerSessionHandle } from "pty-manager";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PTYService } from "../services/pty-service.js";
import type {
  CodingAgentType,
  SpawnSessionOptions,
} from "../services/pty-types.js";
import { clearTaskAgentFrameworkStateCache } from "../services/task-agent-frameworks.js";

// ---------------------------------------------------------------------------
// Fixture: tmp HOME + tmp ELIZA_STATE_DIR so file-system side effects
// (~/.claude.json trust seed, .claude/settings.json, .gitignore) land in a
// throwaway tree, and `safeGetSetting`'s config-file probe finds nothing —
// which forces resolution through `runtime.getSetting(...)`.
// ---------------------------------------------------------------------------

interface SpawnFixture {
  tmpRoot: string;
  homeDir: string;
  workdir: string;
  previous: {
    HOME: string | undefined;
    USERPROFILE: string | undefined;
    ELIZA_STATE_DIR: string | undefined;
    ELIZA_CONFIG_PATH: string | undefined;
    ELIZA_NAMESPACE: string | undefined;
    PARALLAX_CLAUDE_MODEL_POWERFUL: string | undefined;
    PARALLAX_CLAUDE_MODEL_FAST: string | undefined;
    PARALLAX_CODEX_MODEL_POWERFUL: string | undefined;
    PARALLAX_CODEX_MODEL_FAST: string | undefined;
  };
}

function setupFixture(): SpawnFixture {
  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "orch-spawn-prefs-"));
  const homeDir = path.join(tmpRoot, "home");
  const stateDir = path.join(tmpRoot, ".eliza");
  const workdir = path.join(tmpRoot, "workdir");
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(workdir, { recursive: true });

  const previous = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    ELIZA_STATE_DIR: process.env.ELIZA_STATE_DIR,
    ELIZA_CONFIG_PATH: process.env.ELIZA_CONFIG_PATH,
    ELIZA_NAMESPACE: process.env.ELIZA_NAMESPACE,
    PARALLAX_CLAUDE_MODEL_POWERFUL: process.env.PARALLAX_CLAUDE_MODEL_POWERFUL,
    PARALLAX_CLAUDE_MODEL_FAST: process.env.PARALLAX_CLAUDE_MODEL_FAST,
    PARALLAX_CODEX_MODEL_POWERFUL: process.env.PARALLAX_CODEX_MODEL_POWERFUL,
    PARALLAX_CODEX_MODEL_FAST: process.env.PARALLAX_CODEX_MODEL_FAST,
  };

  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;
  process.env.ELIZA_STATE_DIR = stateDir;
  delete process.env.ELIZA_CONFIG_PATH;
  delete process.env.ELIZA_NAMESPACE;
  // Process-env model overrides must not leak into runtime.getSetting fallbacks.
  delete process.env.PARALLAX_CLAUDE_MODEL_POWERFUL;
  delete process.env.PARALLAX_CLAUDE_MODEL_FAST;
  delete process.env.PARALLAX_CODEX_MODEL_POWERFUL;
  delete process.env.PARALLAX_CODEX_MODEL_FAST;

  clearTaskAgentFrameworkStateCache();
  return { tmpRoot, homeDir, workdir, previous };
}

function teardownFixture(fixture: SpawnFixture): void {
  for (const [key, value] of Object.entries(fixture.previous)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  rmSync(fixture.tmpRoot, { recursive: true, force: true });
  clearTaskAgentFrameworkStateCache();
}

// ---------------------------------------------------------------------------
// Fake runtime: returns the exact value of getSetting(key) recorded by the
// caller, mirroring how `safeGetSetting` reads PARALLAX_* keys after the
// config-file probe misses.
// ---------------------------------------------------------------------------

function createRuntime(
  settings: Record<string, string | undefined> = {},
): IAgentRuntime {
  const runtime = {
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
    getSetting: (key: string): string | undefined => settings[key],
    getService: (): null => null,
    services: new Map<string, unknown>(),
  };
  return runtime as unknown as IAgentRuntime;
}

// ---------------------------------------------------------------------------
// Fake manager: records the last spawnConfig and returns a synthetic
// session handle whose status is `stopped` so `setupDeferredTaskDelivery`
// (only invoked when `initialTask` is supplied) won't be triggered.
// We don't supply `initialTask` in these tests anyway — the model-pref
// resolution lands on the spawnConfig before any deferred delivery wires
// up — but the stopped status keeps the fake honest.
// ---------------------------------------------------------------------------

interface FakeManager {
  lastSpawnConfig: (SpawnConfig & { id: string }) | null;
  spawn(config: SpawnConfig & { id: string }): Promise<WorkerSessionHandle>;
  list(): WorkerSessionHandle[];
  get(): WorkerSessionHandle | undefined;
  getSession(): undefined;
  addAutoResponseRule(): void;
}

function createFakeManager(): FakeManager {
  const fake: FakeManager = {
    lastSpawnConfig: null,
    async spawn(config) {
      fake.lastSpawnConfig = config;
      const session: WorkerSessionHandle = {
        id: config.id,
        name: config.name,
        type: config.type,
        status: "stopped",
        pid: undefined,
        cols: 80,
        rows: 24,
        startedAt: new Date(),
        lastActivityAt: new Date(),
      };
      return session;
    },
    list() {
      return [];
    },
    get() {
      return undefined;
    },
    getSession() {
      return undefined;
    },
    addAutoResponseRule() {
      // no-op for tests
    },
  };
  return fake;
}

/**
 * Construct a PTYService without booting the real PTY manager. We bypass
 * `static start()` (which spawns workers and wires the SwarmCoordinator)
 * and instead plant the fake manager directly on the private slot — the
 * same pattern the existing pty-service tests would need to use to
 * exercise the spawn-side code path without standing up a worker
 * subprocess.
 */
function buildServiceWithFakeManager(runtime: IAgentRuntime): {
  service: PTYService;
  manager: FakeManager;
} {
  const service = new PTYService(runtime);
  const manager = createFakeManager();
  // Plant the fake manager on the private slot. PTYService reads
  // `this.manager` and `this.usingBunWorker` to dispatch — the slots are
  // only `private` for compile-time encapsulation, not runtime safety.
  const internal = service as unknown as {
    manager: FakeManager;
    usingBunWorker: boolean;
  };
  internal.manager = manager;
  internal.usingBunWorker = false;
  return { service, manager };
}

function buildOptions(
  overrides: Partial<SpawnSessionOptions> = {},
): SpawnSessionOptions {
  const baseAgentType: CodingAgentType = "claude";
  return {
    name: "x",
    agentType: overrides.agentType ?? baseAgentType,
    workdir: overrides.workdir,
    metadata: overrides.metadata,
    // Intentionally omit `initialTask` — the model-pref resolution under
    // test runs before `setupDeferredTaskDelivery`, and skipping the task
    // avoids scheduling deferred timers that would otherwise leak into
    // sibling tests.
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/**
 * The spawnConfig handed to `manager.spawn(...)` does not carry a top-level
 * `metadata` field — `SpawnConfig` (from adapter-types) only has env,
 * adapterConfig, etc. The resolved metadata is split into two observable
 * surfaces by `spawnSession`:
 *
 *   1. `service.sessionMetadata.set(session.id, resolvedMetadata)` — the
 *      in-process map consulted by stall classification, completion flows,
 *      `getSessionInfo`, etc.
 *   2. `buildSpawnConfig` reads `options.metadata.modelPrefs.powerful` and
 *      maps it onto adapter-specific env keys (ANTHROPIC_MODEL,
 *      OPENAI_MODEL, GEMINI_MODEL, AIDER_MODEL) on the spawnConfig.env so
 *      the child PTY child process actually inherits the chosen model.
 *
 * The recent regression dropped `getTaskAgentModelPrefs(runtime, ...)`
 * inside spawnSession. That broke surface (2) for runtime-settings-only
 * users: their PARALLAX_*_MODEL_POWERFUL never made it onto the env, so
 * the spawned coding agent fell back to its CLI default. Asserting both
 * surfaces below catches that exact failure mode.
 */
function readSessionModelPrefs(
  service: PTYService,
  sessionId: string,
): { powerful?: string; fast?: string } | undefined {
  const internal = service as unknown as {
    sessionMetadata: Map<string, Record<string, unknown>>;
  };
  const stored = internal.sessionMetadata.get(sessionId);
  if (!stored) return undefined;
  const prefs = stored.modelPrefs;
  if (!prefs || typeof prefs !== "object") return undefined;
  return prefs as { powerful?: string; fast?: string };
}

describe("PTYService.spawnSession — model preferences wiring", () => {
  let fixture: SpawnFixture;

  beforeEach(() => {
    fixture = setupFixture();
  });

  afterEach(() => {
    teardownFixture(fixture);
    vi.restoreAllMocks();
  });

  it("threads runtime PARALLAX_CLAUDE_MODEL_* settings into both sessionMetadata and the child env", async () => {
    const runtime = createRuntime({
      PARALLAX_CLAUDE_MODEL_POWERFUL: "opus-test-marker",
      PARALLAX_CLAUDE_MODEL_FAST: "haiku-test-marker",
    });
    const { service, manager } = buildServiceWithFakeManager(runtime);

    const sessionInfo = await service.spawnSession(
      buildOptions({ agentType: "claude", workdir: fixture.workdir }),
    );

    expect(manager.lastSpawnConfig).not.toBeNull();
    const env = manager.lastSpawnConfig?.env;
    // Surface 2: env-keying. This is the surface the regression broke —
    // runtime settings must reach the child PTY's ANTHROPIC_MODEL.
    expect(env?.ANTHROPIC_MODEL).toBe("opus-test-marker");

    // Surface 1: resolved metadata is stashed on the per-session map so
    // downstream consumers (stall classification, completion flows) see
    // the same prefs that the spawn used.
    const stored = readSessionModelPrefs(service, sessionInfo.id);
    expect(stored).toEqual({
      powerful: "opus-test-marker",
      fast: "haiku-test-marker",
    });
  });

  it("lets runtime settings override caller-supplied options.metadata.modelPrefs", async () => {
    // `getTaskAgentModelPrefs(runtime, agentType, spawnPrefs)` merges in
    // the order [defaults, spawnPrefs, runtimePrefs] — runtime wins so
    // user-level overrides can't be silently shadowed by a caller
    // hardcoding a model. The existing helper-level test
    // ("keeps runtime settings ahead of spawn metadata and central
    // defaults") asserts this for `getTaskAgentModelPrefs` in isolation;
    // here we lock the same precedence in through the spawn pipe.
    const runtime = createRuntime({
      PARALLAX_CLAUDE_MODEL_POWERFUL: "opus-runtime",
    });
    const { service, manager } = buildServiceWithFakeManager(runtime);

    const sessionInfo = await service.spawnSession(
      buildOptions({
        agentType: "claude",
        workdir: fixture.workdir,
        metadata: { modelPrefs: { powerful: "opus-caller" } },
      }),
    );

    expect(manager.lastSpawnConfig?.env?.ANTHROPIC_MODEL).toBe("opus-runtime");
    expect(readSessionModelPrefs(service, sessionInfo.id)?.powerful).toBe(
      "opus-runtime",
    );
  });

  it("falls back to the central default when neither runtime settings nor caller metadata supply a pref", async () => {
    // No runtime override, no caller override — the centralized default
    // for claude (powerful: claude-opus-4-7) is the only contributor.
    // This documents that `spawnConfig.metadata.modelPrefs` is never
    // wholly absent for an adapter-backed agent: the adapter's central
    // default always lands on it.
    const runtime = createRuntime();
    const { service, manager } = buildServiceWithFakeManager(runtime);

    const sessionInfo = await service.spawnSession(
      buildOptions({ agentType: "claude", workdir: fixture.workdir }),
    );

    expect(manager.lastSpawnConfig?.env?.ANTHROPIC_MODEL).toBe(
      "claude-opus-4-7",
    );
    expect(readSessionModelPrefs(service, sessionInfo.id)).toEqual({
      powerful: "claude-opus-4-7",
    });
  });

  it("writes the parent runtime bridge reference into the agent memory file", async () => {
    const runtime = createRuntime({ SERVER_PORT: "31337" });
    const { service } = buildServiceWithFakeManager(runtime);

    const sessionInfo = await service.spawnSession(
      buildOptions({ agentType: "claude", workdir: fixture.workdir }),
    );

    const memoryPath = path.join(
      fixture.workdir,
      service.getMemoryFilePath("claude"),
    );
    const memory = readFileSync(memoryPath, "utf8");
    expect(memory).toContain("# Parent Eliza Runtime");
    expect(memory).toContain(
      `http://127.0.0.1:31337/api/coding-agents/${sessionInfo.id}/parent-context`,
    );
    expect(memory).toContain(
      `http://127.0.0.1:31337/api/coding-agents/${sessionInfo.id}/active-workspaces`,
    );
  });

  it("routes codex agentType through PARALLAX_CODEX_MODEL_* keys, not the claude keys", async () => {
    // Per-adapter routing. The claude key is set but must be ignored for
    // a codex spawn — `getTaskAgentModelPrefs` reads the codex-specific
    // setting keys (PARALLAX_CODEX_MODEL_POWERFUL/FAST) and the codex
    // env mapping (OPENAI_MODEL, not ANTHROPIC_MODEL) flows through.
    const runtime = createRuntime({
      PARALLAX_CLAUDE_MODEL_POWERFUL: "claude-should-not-leak",
      PARALLAX_CODEX_MODEL_POWERFUL: "gpt-codex-marker",
      PARALLAX_CODEX_MODEL_FAST: "gpt-codex-fast",
    });
    const { service, manager } = buildServiceWithFakeManager(runtime);

    const sessionInfo = await service.spawnSession(
      buildOptions({ agentType: "codex", workdir: fixture.workdir }),
    );

    expect(manager.lastSpawnConfig?.env?.OPENAI_MODEL).toBe("gpt-codex-marker");
    // The claude env key must not have been written for a codex spawn.
    expect(manager.lastSpawnConfig?.env?.ANTHROPIC_MODEL).toBeUndefined();
    // Codex CLI removed the old --full-auto flag; permissions now flow through
    // a per-session CODEX_HOME/config.toml instead of adapter CLI flags.
    expect(
      manager.lastSpawnConfig?.adapterConfig?.approvalPreset,
    ).toBeUndefined();
    const codexHome = manager.lastSpawnConfig?.env?.CODEX_HOME;
    expect(codexHome).toContain("eliza-codex-");
    if (!codexHome) throw new Error("expected Codex home to be configured");
    const configToml = readFileSync(
      path.join(codexHome, "config.toml"),
      "utf8",
    );
    expect(configToml).toContain('approval_policy = "never"');
    expect(configToml).toContain('sandbox_mode = "workspace-write"');
    expect(configToml).toContain("[tools]");
    expect(configToml).toContain("web_search = true");
    rmSync(codexHome, { recursive: true, force: true });

    const stored = readSessionModelPrefs(service, sessionInfo.id);
    expect(stored).toEqual({
      powerful: "gpt-codex-marker",
      fast: "gpt-codex-fast",
    });
  });
});
