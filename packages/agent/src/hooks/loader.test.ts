/**
 * Hook Loader — Unit Tests
 *
 * Tests for:
 * - loadHooks orchestration (disabled, clears hooks, skips ineligible/disabled/no-events, registers)
 * - Path safety (legacy handlers under/outside allowed roots)
 * - Config extraDirs safety (must be under ~/.eliza/)
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { InternalHooksConfig } from "../config/types.hooks";
import type { ElizaHookMetadata, HookEntry } from "./types";

// ---------------------------------------------------------------------------
// mocks
// ---------------------------------------------------------------------------

// Use a deterministic fake homedir so loader.ts and test code agree on paths
const FAKE_HOME = join(tmpdir(), "__loader_test_home__");
vi.mock("node:os", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("node:os");
  return { ...actual, homedir: () => FAKE_HOME };
});

vi.mock("@elizaos/core", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

// Mock discoverHooks to return controlled entries
const mockDiscoverHooks = vi.fn<() => Promise<HookEntry[]>>();
vi.mock("./discovery", () => ({
  discoverHooks: (...args: unknown[]) => mockDiscoverHooks(...(args as [])),
}));

// Mock eligibility — default to eligible
const mockCheckEligibility = vi.fn();
const mockResolveHookConfig = vi.fn();
vi.mock("./eligibility", () => ({
  checkEligibility: (...args: unknown[]) =>
    mockCheckEligibility(...(args as [])),
  resolveHookConfig: (...args: unknown[]) =>
    mockResolveHookConfig(...(args as [])),
}));

// Track calls to registerHook and clearHooks
const mockRegisterHook = vi.fn();
const mockClearHooks = vi.fn();
vi.mock("./registry", () => ({
  registerHook: (...args: unknown[]) => mockRegisterHook(...(args as [])),
  clearHooks: () => mockClearHooks(),
}));

// ---------------------------------------------------------------------------
// shared temp dir for handler files
// ---------------------------------------------------------------------------

let tempRoot: string;
let dummyHandlerPath: string;

beforeAll(async () => {
  tempRoot = join(
    tmpdir(),
    `loader-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(tempRoot, { recursive: true });

  // Create a reusable dummy handler module
  dummyHandlerPath = join(tempRoot, "handler.mjs");
  await writeFile(
    dummyHandlerPath,
    "export default function handler(event) {}",
    "utf-8",
  );
});

afterAll(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makeEntry(
  name: string,
  opts: {
    events?: string[];
    hookKey?: string;
    emoji?: string;
    export?: string;
    handlerPath?: string;
    source?: HookEntry["hook"]["source"];
  } = {},
): HookEntry {
  const metadata: ElizaHookMetadata | undefined =
    opts.events !== undefined
      ? {
          events: opts.events,
          hookKey: opts.hookKey,
          emoji: opts.emoji,
          export: opts.export,
        }
      : undefined;

  return {
    hook: {
      name,
      description: `${name} description`,
      source: opts.source ?? "eliza-bundled",
      filePath: `/fake/hooks/${name}/HOOK.md`,
      baseDir: `/fake/hooks/${name}`,
      handlerPath: opts.handlerPath ?? `/fake/hooks/${name}/handler.ts`,
    },
    frontmatter: { name, description: `${name} description` },
    metadata,
  };
}

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockDiscoverHooks.mockResolvedValue([]);
  mockCheckEligibility.mockReturnValue({ eligible: true, missing: [] });
  mockResolveHookConfig.mockReturnValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// import loadHooks lazily so mocks are set up first
// ---------------------------------------------------------------------------

async function getLoadHooks() {
  const mod = await import("./loader");
  return mod.loadHooks;
}

// ============================================================================
//  1. loadHooks orchestration
// ============================================================================

describe("loadHooks orchestration", () => {
  it("returns zeros and does nothing when internalConfig.enabled === false", async () => {
    const loadHooks = await getLoadHooks();

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
    expect(mockDiscoverHooks).not.toHaveBeenCalled();
    expect(mockClearHooks).not.toHaveBeenCalled();
  });

  it("clears existing hooks before loading", async () => {
    const loadHooks = await getLoadHooks();
    mockDiscoverHooks.mockResolvedValue([]);

    await loadHooks({});

    expect(mockClearHooks).toHaveBeenCalledOnce();
  });

  it("skips ineligible hooks into result.skipped", async () => {
    const loadHooks = await getLoadHooks();
    const entry = makeEntry("ineligible-hook", {
      events: ["command:new"],
    });
    mockDiscoverHooks.mockResolvedValue([entry]);
    mockCheckEligibility.mockReturnValue({
      eligible: false,
      missing: ["Binary missing: ffmpeg"],
    });

    const result = await loadHooks({});

    expect(result.discovered).toBe(1);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toContain("ineligible-hook");
    expect(result.skipped[0]).toContain("Binary missing: ffmpeg");
    expect(result.registered).toBe(0);
  });

  it("skips hooks when hookConfig.enabled === false", async () => {
    const loadHooks = await getLoadHooks();
    const entry = makeEntry("disabled-hook", {
      events: ["command:new"],
    });
    mockDiscoverHooks.mockResolvedValue([entry]);
    mockCheckEligibility.mockReturnValue({ eligible: true, missing: [] });
    mockResolveHookConfig.mockReturnValue({ enabled: false });

    const result = await loadHooks({});

    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toContain("disabled in config");
    expect(result.registered).toBe(0);
  });

  it("skips hooks with no events configured", async () => {
    const loadHooks = await getLoadHooks();
    // Handler import must succeed for the no-events check to be reached
    const entry = makeEntry("no-events-hook", {
      events: [],
      handlerPath: dummyHandlerPath,
    });
    mockDiscoverHooks.mockResolvedValue([entry]);

    const result = await loadHooks({});

    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toContain("no events");
    expect(result.registered).toBe(0);
  });

  it("counts failed handler imports in result.failed", async () => {
    const loadHooks = await getLoadHooks();
    const entry = makeEntry("bad-import-hook", {
      events: ["command:new"],
      handlerPath: "/nonexistent/path/handler.ts",
    });
    mockDiscoverHooks.mockResolvedValue([entry]);

    const result = await loadHooks({});

    expect(result.failed).toContain("bad-import-hook");
    expect(result.registered).toBe(0);
  });

  it("registers successful hooks for all event keys", async () => {
    const loadHooks = await getLoadHooks();
    const entry = makeEntry("good-hook", {
      events: ["command:new", "session:start"],
      handlerPath: dummyHandlerPath,
    });
    mockDiscoverHooks.mockResolvedValue([entry]);

    const result = await loadHooks({});

    expect(result.registered).toBe(1);
    expect(mockRegisterHook).toHaveBeenCalledTimes(2);
    expect(mockRegisterHook).toHaveBeenCalledWith(
      "command:new",
      expect.any(Function),
    );
    expect(mockRegisterHook).toHaveBeenCalledWith(
      "session:start",
      expect.any(Function),
    );
  });

  it("uses hookKey from metadata when available", async () => {
    const loadHooks = await getLoadHooks();
    const entry = makeEntry("display-name", {
      events: ["command:new"],
      hookKey: "custom-config-key",
    });
    mockDiscoverHooks.mockResolvedValue([entry]);

    await loadHooks({
      internalConfig: {
        entries: { "custom-config-key": { enabled: false } },
      },
    });

    expect(mockResolveHookConfig).toHaveBeenCalledWith(
      expect.anything(),
      "custom-config-key",
    );
  });
});

// ============================================================================
//  2. Path safety (legacy handlers)
// ============================================================================

describe("path safety — legacy handlers", () => {
  it("rejects legacy handler with module path outside allowed roots", async () => {
    const { logger } = await import("@elizaos/core");
    const loadHooks = await getLoadHooks();
    mockDiscoverHooks.mockResolvedValue([]);

    const config: InternalHooksConfig = {
      handlers: [
        {
          event: "command:new",
          module: "/etc/malicious/handler.ts",
        },
      ],
    };

    const result = await loadHooks({ internalConfig: config });

    expect(result.failed).toContain("/etc/malicious/handler.ts");
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("outside allowed hook directories"),
    );
  });

  it("accepts legacy handler with module path under allowed root", async () => {
    const loadHooks = await getLoadHooks();
    mockDiscoverHooks.mockResolvedValue([]);

    // FAKE_HOME is the mocked homedir — managed hooks dir = FAKE_HOME/.eliza/hooks
    const managedPath = resolve(
      FAKE_HOME,
      ".eliza",
      "hooks",
      "my-hook",
      "handler.ts",
    );
    const config: InternalHooksConfig = {
      handlers: [
        {
          event: "command:new",
          module: managedPath,
        },
      ],
    };

    // The handler import will fail (file doesn't exist), but path validation passes
    const result = await loadHooks({ internalConfig: config });

    // Should fail on import, not on path validation
    expect(result.failed).toContain(managedPath);
    // The warning should NOT mention "outside allowed"
    const { logger } = await import("@elizaos/core");
    const outsideCalls = (
      logger.warn as ReturnType<typeof vi.fn>
    ).mock.calls.filter(
      (call: unknown[]) =>
        typeof call[0] === "string" && call[0].includes("outside allowed"),
    );
    expect(outsideCalls).toHaveLength(0);
  });
});

// ============================================================================
//  3. Config extraDirs safety
// ============================================================================

describe("config extraDirs safety", () => {
  it("rejects config extraDirs outside ~/.eliza/", async () => {
    const { logger } = await import("@elizaos/core");
    const loadHooks = await getLoadHooks();
    mockDiscoverHooks.mockResolvedValue([]);

    const config: InternalHooksConfig = {
      load: {
        extraDirs: ["/tmp/attacker-controlled"],
      },
    };

    await loadHooks({ internalConfig: config });

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'Rejected config extraDir "/tmp/attacker-controlled"',
      ),
    );
  });

  it("accepts config extraDirs under ~/.eliza/", async () => {
    const { logger } = await import("@elizaos/core");
    const loadHooks = await getLoadHooks();
    mockDiscoverHooks.mockResolvedValue([]);

    // Use absolute path under the mocked homedir's .eliza
    const safePath = resolve(FAKE_HOME, ".eliza", "custom-hooks");
    const config: InternalHooksConfig = {
      load: {
        extraDirs: [safePath],
      },
    };

    await loadHooks({ internalConfig: config });

    // Should NOT warn about rejection
    const rejectCalls = (
      logger.warn as ReturnType<typeof vi.fn>
    ).mock.calls.filter(
      (call: unknown[]) =>
        typeof call[0] === "string" &&
        call[0].includes("Rejected config extraDir"),
    );
    expect(rejectCalls).toHaveLength(0);

    // The safe dir should be passed to discoverHooks
    expect(mockDiscoverHooks).toHaveBeenCalledWith(
      expect.objectContaining({
        extraDirs: expect.arrayContaining([safePath]),
      }),
    );
  });
});
