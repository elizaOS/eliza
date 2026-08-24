/**
 * Covers the hook loader pipeline end to end: the disabled fast path, registry
 * clearing, eligibility gating, explicit disable, handler-module loading, the
 * no-events guard, config extraDir containment, and legacy-handler path safety.
 *
 * The harness is real: every case writes actual HOOK.md + handler.mjs fixtures
 * into temporary directories, points ELIZA_STATE_DIR at them, and drives the
 * exported loadHooks() against the real discovery/eligibility/registry
 * modules. Dispatch is observed through a recorder handler installed by the
 * fixture itself, so a passing assertion means the real dynamic-import +
 * registerHook path ran, not a stub.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadHooks } from "./loader.ts";
import {
  clearHooks,
  createHookEvent,
  registerHook,
  triggerHook,
} from "./registry.ts";
import type { HookEvent, HookHandler } from "./types.ts";

const CALLS_KEY = "__loaderTestCalls";

const CURRENT_OS = platform();
const OTHER_OS = CURRENT_OS === "darwin" ? "linux" : "darwin";
const MISSING_BIN = "eliza-definitely-missing-binary-xyz";
const MISSING_ENV = "ELIZA_HOOK_LOADER_TEST_MISSING";

/** Recorder handler source: appends each dispatch to a global journal. */
const RECORDER_SOURCE = [
  "globalThis.__loaderTestCalls ??= [];",
  "export default function (event) {",
  "  globalThis.__loaderTestCalls.push({",
  "    action: event.action,",
  "    sessionKey: event.sessionKey,",
  "  });",
  "}",
].join("\n");

const NAMED_RECORDER_SOURCE = [
  "globalThis.__loaderTestCalls ??= [];",
  "export function onGateway(event) {",
  "  globalThis.__loaderTestCalls.push({",
  "    action: event.action,",
  "    sessionKey: event.sessionKey,",
  "  });",
  "}",
].join("\n");

const NON_FUNCTION_SOURCE = "export default 42;\n";

interface RecordedCall {
  action?: string;
  sessionKey?: string;
}

function recordedCalls(): RecordedCall[] {
  const value = (globalThis as unknown as Record<string, unknown>)[CALLS_KEY];
  return Array.isArray(value) ? (value as RecordedCall[]) : [];
}

function makeSentinel(calls: string[]): HookHandler {
  return (event: HookEvent) => {
    calls.push(`${event.type}:${event.action}`);
  };
}

let previousStateDir: string | undefined;
const tempDirs: string[] = [];

beforeEach(() => {
  delete (globalThis as unknown as Record<string, unknown>)[CALLS_KEY];
  previousStateDir = process.env.ELIZA_STATE_DIR;
});

afterEach(async () => {
  if (previousStateDir === undefined) delete process.env.ELIZA_STATE_DIR;
  else process.env.ELIZA_STATE_DIR = previousStateDir;
  clearHooks();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

/** Create an isolated state dir and point ELIZA_STATE_DIR at it. */
async function useStateDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "eliza-hook-state-"));
  tempDirs.push(dir);
  process.env.ELIZA_STATE_DIR = dir;
  return dir;
}

/** Create an unrelated temp root that is never an allowed hook root. */
async function useOutsideDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "eliza-hook-outside-"));
  tempDirs.push(dir);
  return dir;
}

interface HookFixture {
  name: string;
  description?: string;
  /** Serialized `eliza` metadata object, or null to omit the metadata line. */
  metadata?: Record<string, unknown> | null;
  handlerSource?: string;
  handlerFileName?: string;
}

/** Write `<root>/<name>/HOOK.md` plus a handler module into a hooks root. */
async function writeHook(
  rootDir: string,
  fixture: HookFixture,
): Promise<string> {
  const hookDir = join(rootDir, fixture.name);
  await mkdir(hookDir, { recursive: true });
  const lines = [
    "---",
    `name: ${fixture.name}`,
    `description: ${fixture.description ?? "test hook"}`,
  ];
  if (fixture.metadata !== null) {
    lines.push(
      `metadata: ${JSON.stringify({ eliza: fixture.metadata ?? {} })}`,
    );
  }
  lines.push("---", "");
  await writeFile(join(hookDir, "HOOK.md"), lines.join("\n"), "utf8");
  await writeFile(
    join(hookDir, fixture.handlerFileName ?? "handler.mjs"),
    fixture.handlerSource ?? RECORDER_SOURCE,
    "utf8",
  );
  return hookDir;
}

function gatewayEvent(action = "new"): HookEvent {
  return createHookEvent("gateway", action, "session-gw");
}

describe("loadHooks", () => {
  it("returns zeros and leaves the existing registry untouched when hooks are disabled", async () => {
    await useStateDir();
    const sentinelCalls: string[] = [];
    registerHook("gateway", makeSentinel(sentinelCalls));

    const result = await loadHooks({
      internalConfig: { enabled: false },
    });

    expect(result).toEqual({
      discovered: 0,
      eligible: 0,
      registered: 0,
      skipped: [],
      failed: [],
    });
    // The disabled fast path returns before clearHooks(), so prior
    // registrations survive until a real load replaces them.
    await triggerHook(gatewayEvent("reset"));
    expect(sentinelCalls).toEqual(["gateway:reset"]);
  });

  it("clears previously registered hooks when a real load runs", async () => {
    const stateDir = await useStateDir();
    await mkdir(join(stateDir, "hooks"), { recursive: true });
    const sentinelCalls: string[] = [];
    registerHook("gateway", makeSentinel(sentinelCalls));

    const result = await loadHooks({});

    expect(result.discovered).toBe(0);
    await triggerHook(gatewayEvent());
    expect(sentinelCalls).toEqual([]);
  });

  it("registers an eligible hook and dispatches real events through the registry", async () => {
    const stateDir = await useStateDir();
    await writeHook(join(stateDir, "hooks"), {
      name: "greeter",
      description: "records command:new dispatches",
      metadata: { events: ["command:new"] },
    });

    const result = await loadHooks({});

    expect(result).toEqual({
      discovered: 1,
      eligible: 1,
      registered: 1,
      skipped: [],
      failed: [],
    });

    await triggerHook(createHookEvent("command", "new", "session-a"));
    await triggerHook(createHookEvent("command", "other", "session-b"));

    // Registered only under the specific "command:new" key: the general
    // "command" bucket must stay empty for other actions.
    expect(recordedCalls()).toEqual([
      { action: "new", sessionKey: "session-a" },
    ]);
  });

  it("skips ineligible hooks listing every missing requirement", async () => {
    const stateDir = await useStateDir();
    await writeHook(join(stateDir, "hooks"), {
      name: "needy",
      metadata: {
        events: ["gateway"],
        requires: {
          bins: [MISSING_BIN],
          env: [MISSING_ENV],
          config: ["hooks.featureFlag"],
        },
      },
    });

    const result = await loadHooks({ internalConfig: {}, elizaConfig: {} });

    expect(result.discovered).toBe(1);
    expect(result.eligible).toBe(0);
    expect(result.registered).toBe(0);
    expect(result.failed).toEqual([]);
    expect(result.skipped).toEqual([
      `needy: Binary missing: ${MISSING_BIN}, Env missing: ${MISSING_ENV}, Config missing: hooks.featureFlag`,
    ]);
  });

  it("satisfies env requirements through the per-hook config env map", async () => {
    const stateDir = await useStateDir();
    await writeHook(join(stateDir, "hooks"), {
      name: "env-hook",
      metadata: {
        hookKey: "alias-key",
        events: ["command:new"],
        requires: { env: [MISSING_ENV] },
      },
    });

    const result = await loadHooks({
      internalConfig: {
        entries: { "alias-key": { env: { [MISSING_ENV]: "provided" } } },
      },
    });

    // The requirement was met through hookConfig.env alone (the process env
    // stays unset), and the lookup went through the hookKey alias.
    expect(result.registered).toBe(1);
    expect(result.skipped).toEqual([]);

    await triggerHook(createHookEvent("command", "new", "session-env"));
    expect(recordedCalls()).toEqual([
      { action: "new", sessionKey: "session-env" },
    ]);
  });

  it("satisfies config-path requirements from the provided elizaConfig", async () => {
    const stateDir = await useStateDir();
    await writeHook(join(stateDir, "hooks"), {
      name: "config-hook",
      metadata: {
        events: ["gateway"],
        requires: { config: ["hooks.allowNetwork"] },
      },
    });

    const without = await loadHooks({ elizaConfig: {} });
    expect(without.skipped).toEqual([
      "config-hook: Config missing: hooks.allowNetwork",
    ]);

    const withConfig = await loadHooks({
      elizaConfig: { hooks: { allowNetwork: true } },
    });
    expect(withConfig.registered).toBe(1);
  });

  it("lets always:true bypass requirement checks but not the OS gate", async () => {
    const stateDir = await useStateDir();
    await writeHook(join(stateDir, "hooks"), {
      name: "stubborn",
      metadata: {
        always: true,
        events: ["gateway"],
        requires: { bins: [MISSING_BIN], env: [MISSING_ENV] },
      },
    });

    const result = await loadHooks({});
    expect(result.registered).toBe(1);
    expect(result.skipped).toEqual([]);
  });

  it("still applies the OS gate to always:true hooks", async () => {
    const stateDir = await useStateDir();
    await writeHook(join(stateDir, "hooks"), {
      name: "foreign-os",
      metadata: {
        always: true,
        os: [OTHER_OS],
        events: ["gateway"],
      },
    });

    const result = await loadHooks({});
    expect(result.eligible).toBe(0);
    expect(result.registered).toBe(0);
    expect(result.skipped).toEqual([
      `foreign-os: OS: requires ${OTHER_OS}, current: ${CURRENT_OS}`,
    ]);
  });

  it("reports explicitly disabled hooks as disabled while still counting them eligible", async () => {
    const stateDir = await useStateDir();
    await writeHook(join(stateDir, "hooks"), {
      name: "switched-off",
      metadata: { events: ["gateway"] },
    });

    const result = await loadHooks({
      internalConfig: { entries: { "switched-off": { enabled: false } } },
    });

    // Eligibility (requirements) passed even though the user choice disables
    // the hook — the two states are reported separately.
    expect(result.eligible).toBe(1);
    expect(result.registered).toBe(0);
    expect(result.skipped).toEqual(["switched-off: disabled in config"]);
  });

  it("fails a hook whose handler module lacks the configured export", async () => {
    const stateDir = await useStateDir();
    await writeHook(join(stateDir, "hooks"), {
      name: "wrong-export-name",
      metadata: { events: ["gateway"], export: "onNamed" },
    });
    await writeHook(join(stateDir, "hooks"), {
      name: "non-function-export",
      metadata: { events: ["gateway"] },
      handlerSource: NON_FUNCTION_SOURCE,
    });

    const result = await loadHooks({});

    expect(result.discovered).toBe(2);
    expect(result.eligible).toBe(2);
    expect(result.registered).toBe(0);
    expect(result.skipped).toEqual([]);
    // Both hooks fail; directory scan order is not guaranteed.
    expect([...result.failed].sort()).toEqual([
      "non-function-export",
      "wrong-export-name",
    ]);
  });

  it("skips hooks whose metadata declares no events", async () => {
    const stateDir = await useStateDir();
    await writeHook(join(stateDir, "hooks"), {
      name: "no-events",
      metadata: { emoji: "🧪" },
    });

    const result = await loadHooks({});
    expect(result.eligible).toBe(1);
    expect(result.registered).toBe(0);
    expect(result.skipped).toEqual(["no-events: no events"]);
  });

  it("skips hooks without any eliza metadata as having no events", async () => {
    const stateDir = await useStateDir();
    await writeHook(join(stateDir, "hooks"), {
      name: "bare",
      metadata: null,
    });

    const result = await loadHooks({});
    expect(result.eligible).toBe(1);
    expect(result.registered).toBe(0);
    expect(result.skipped).toEqual(["bare: no events"]);
  });

  it("rejects internalConfig extraDirs outside the state dir", async () => {
    await useStateDir();
    const outside = await useOutsideDir();
    await writeHook(join(outside, "injected"), {
      name: "injectee",
      metadata: { events: ["gateway"] },
    });

    const result = await loadHooks({
      internalConfig: { load: { extraDirs: [join(outside, "injected")] } },
    });

    // A fully valid hook living in a disallowed directory is never scanned.
    expect(result.discovered).toBe(0);
    expect(result.registered).toBe(0);
    expect(result.skipped).toEqual([]);
    expect(result.failed).toEqual([]);
  });

  it("accepts internalConfig extraDirs inside the state dir", async () => {
    const stateDir = await useStateDir();
    await writeHook(join(stateDir, "extra-hooks"), {
      name: "extra-resident",
      metadata: { events: ["gateway"] },
    });

    const result = await loadHooks({
      internalConfig: {
        load: { extraDirs: [join(stateDir, "extra-hooks")] },
      },
    });

    expect(result.discovered).toBe(1);
    expect(result.registered).toBe(1);

    await triggerHook(gatewayEvent());
    expect(recordedCalls()).toEqual([
      { action: "new", sessionKey: "session-gw" },
    ]);
  });

  it("registers legacy handlers whose modules live under allowed roots", async () => {
    const stateDir = await useStateDir();
    const hooksDir = join(stateDir, "hooks");
    await mkdir(hooksDir, { recursive: true });
    await writeFile(
      join(hooksDir, "legacy-handler.mjs"),
      NAMED_RECORDER_SOURCE,
      "utf8",
    );

    const result = await loadHooks({
      internalConfig: {
        handlers: [
          {
            module: join(hooksDir, "legacy-handler.mjs"),
            event: "gateway",
            export: "onGateway",
          },
        ],
      },
    });

    expect(result.discovered).toBe(0);
    expect(result.registered).toBe(1);

    await triggerHook(gatewayEvent("legacy"));
    expect(recordedCalls()).toEqual([
      { action: "legacy", sessionKey: "session-gw" },
    ]);
  });

  it("rejects legacy handlers whose modules live outside allowed roots", async () => {
    await useStateDir();
    const outside = await useOutsideDir();
    const evilModule = join(outside, "evil-handler.mjs");
    await writeFile(evilModule, NAMED_RECORDER_SOURCE, "utf8");

    const result = await loadHooks({
      internalConfig: {
        handlers: [
          { module: evilModule, event: "gateway", export: "onGateway" },
        ],
      },
    });

    expect(result.registered).toBe(0);
    expect(result.failed).toEqual([evilModule]);

    await triggerHook(gatewayEvent());
    expect(recordedCalls()).toEqual([]);
  });
});
