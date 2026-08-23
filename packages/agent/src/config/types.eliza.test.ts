/**
 * Covers the agent-scoped `types.eliza` compatibility barrel: it re-exports
 * `@elizaos/shared` config types and companion helpers. These tests import
 * only from `./types.eliza.ts` and drive the real helpers (empty / single /
 * overflow collections, missing-path removal, comparator / clamp edges).
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  it,
} from "vitest";
import type {
  ConfigFileSnapshot,
  ConfigValidationIssue,
  ElizaConfig,
} from "./types.eliza.ts";
import * as typesEliza from "./types.eliza.ts";
import {
  applyConfigOverrides,
  asNonEmptyString,
  asObjectArray,
  asRecord,
  asRecordOrUndefined,
  CHAT_IMAGE_MIME_TYPE_SET,
  CHAT_UPLOAD_MIME_TYPE_SET,
  CONNECTOR_IDS,
  ELIZA_LOCAL_CONNECTOR_IDS,
  getConfigOverrides,
  getConfigValueAtPath,
  isCloudRuntimeMode,
  isDistributionProfile,
  isLocalRuntimeMode,
  isPlainObject,
  isSafeLocalMode,
  isYoloLocalMode,
  MAX_CHAT_IMAGE_BASE64_BYTES,
  MAX_CHAT_IMAGE_RAW_BYTES,
  MAX_CHAT_UPLOAD_ATTACHMENTS,
  MAX_RESTORABLE_AGENT_BACKUP_BYTES,
  maxRawBytesForBase64,
  normalizeRuntimeExecutionMode,
  parseAllowedHostEnv,
  parseConfigPath,
  parseDurationMs,
  RUNTIME_EXECUTION_MODE_DEFINITIONS,
  RUNTIME_EXECUTION_MODES,
  readRuntimeExecutionModeConfig,
  resetConfigOverrides,
  resolveDistributionProfile,
  resolveRetainableAgentBackupBytes,
  runtimeExecutionModeForDeploymentTarget,
  SnapshotPayloadTooLargeError,
  setConfigOverride,
  setConfigValueAtPath,
  shouldUseCloudOnlyBranding,
  unsetConfigOverride,
  unsetConfigValueAtPath,
} from "./types.eliza.ts";

const ENV_KEYS = [
  "ELIZA_RUNTIME_MODE",
  "RUNTIME_MODE",
  "LOCAL_RUNTIME_MODE",
  "ELIZA_DISTRIBUTION_PROFILE",
] as const;

const envSnapshot: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    envSnapshot[key] = process.env[key];
    delete process.env[key];
  }
  resetConfigOverrides();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const previous = envSnapshot[key];
    if (previous === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = previous;
    }
  }
  resetConfigOverrides();
});

describe("types.eliza barrel", () => {
  it("re-exports runtime config helpers, not an empty types-only module", () => {
    expect(Object.keys(typesEliza).length).toBeGreaterThan(0);
    expect(typeof parseDurationMs).toBe("function");
    expect(typeof resolveRetainableAgentBackupBytes).toBe("function");
    expect(typeof normalizeRuntimeExecutionMode).toBe("function");
    expect(typeof parseConfigPath).toBe("function");
    expect(typeof parseAllowedHostEnv).toBe("function");
    expect(Array.isArray(CONNECTOR_IDS)).toBe(true);
  });

  it("re-exports ElizaConfig as a fully-optional tree and ConfigFileSnapshot as a required envelope", () => {
    expectTypeOf<ElizaConfig>().toMatchTypeOf<Record<string, unknown>>();
    expectTypeOf<ConfigFileSnapshot["config"]>().toEqualTypeOf<ElizaConfig>();
    expectTypeOf<ConfigFileSnapshot["issues"]>().toEqualTypeOf<
      ConfigValidationIssue[]
    >();
    const snapshot: ConfigFileSnapshot = {
      path: "/tmp/eliza.json",
      exists: false,
      raw: null,
      parsed: null,
      valid: true,
      config: {},
      issues: [],
      warnings: [],
    };
    expect(snapshot.config).toEqual({});
    expect(snapshot.issues).toEqual([]);
  });
});

describe("CONNECTOR_IDS", () => {
  it("appends the local wechat connector after the core ids and stays unique", () => {
    expect(ELIZA_LOCAL_CONNECTOR_IDS).toEqual(["wechat"]);
    expect(CONNECTOR_IDS[CONNECTOR_IDS.length - 1]).toBe("wechat");
    expect(CONNECTOR_IDS).toContain("telegram");
    expect(CONNECTOR_IDS).toContain("discord");
    expect(new Set(CONNECTOR_IDS).size).toBe(CONNECTOR_IDS.length);
  });
});

describe("parseDurationMs", () => {
  it("throws on empty or unparseable input", () => {
    expect(() => parseDurationMs("")).toThrow(/invalid duration \(empty\)/);
    expect(() => parseDurationMs("   ")).toThrow(/invalid duration \(empty\)/);
    expect(() => parseDurationMs("nope")).toThrow(/invalid duration: nope/);
    expect(() => parseDurationMs("1e3ms")).toThrow(/invalid duration: 1e3ms/);
  });

  it("parses each unit and a bare number with the default unit", () => {
    expect(parseDurationMs("500ms")).toBe(500);
    expect(parseDurationMs("30s")).toBe(30_000);
    expect(parseDurationMs("5m")).toBe(300_000);
    expect(parseDurationMs("2h")).toBe(7_200_000);
    expect(parseDurationMs("1d")).toBe(86_400_000);
    expect(parseDurationMs("5")).toBe(5);
    expect(parseDurationMs("5", { defaultUnit: "s" })).toBe(5_000);
    expect(parseDurationMs("  2H  ")).toBe(7_200_000);
  });

  it("rejects an overflow that is not a finite safe integer of milliseconds", () => {
    expect(() => parseDurationMs(`${"9".repeat(400)}d`)).toThrow(
      /invalid duration/,
    );
  });
});

describe("resolveRetainableAgentBackupBytes", () => {
  it("defaults absent or blank overrides to the canonical restore ceiling", () => {
    expect(resolveRetainableAgentBackupBytes(undefined)).toBe(
      MAX_RESTORABLE_AGENT_BACKUP_BYTES,
    );
    expect(resolveRetainableAgentBackupBytes("")).toBe(
      MAX_RESTORABLE_AGENT_BACKUP_BYTES,
    );
    expect(resolveRetainableAgentBackupBytes("   ")).toBe(
      MAX_RESTORABLE_AGENT_BACKUP_BYTES,
    );
    expect(MAX_RESTORABLE_AGENT_BACKUP_BYTES).toBe(128 * 1024 * 1024);
  });

  it("throws on malformed or non-positive overrides instead of prefix-parsing them", () => {
    expect(() => resolveRetainableAgentBackupBytes("128MiB")).toThrow(
      /positive integer count of bytes/,
    );
    expect(() => resolveRetainableAgentBackupBytes("128abc")).toThrow(
      /positive integer count of bytes/,
    );
    expect(() => resolveRetainableAgentBackupBytes("0")).toThrow(
      /positive integer count of bytes/,
    );
    expect(() => resolveRetainableAgentBackupBytes("-1")).toThrow(
      /positive integer count of bytes/,
    );
  });

  it("clamps a single valid override that overflows the restore ceiling", () => {
    expect(resolveRetainableAgentBackupBytes("1")).toBe(1);
    expect(
      resolveRetainableAgentBackupBytes(
        String(MAX_RESTORABLE_AGENT_BACKUP_BYTES),
      ),
    ).toBe(MAX_RESTORABLE_AGENT_BACKUP_BYTES);
    expect(
      resolveRetainableAgentBackupBytes(
        String(MAX_RESTORABLE_AGENT_BACKUP_BYTES + 1),
      ),
    ).toBe(MAX_RESTORABLE_AGENT_BACKUP_BYTES);
  });
});

describe("SnapshotPayloadTooLargeError", () => {
  it("names the refusal and records payload vs limit bytes", () => {
    const error = new SnapshotPayloadTooLargeError(200, 100);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("SnapshotPayloadTooLargeError");
    expect(error.payloadBytes).toBe(200);
    expect(error.limitBytes).toBe(100);
    expect(error.message).toContain("200");
    expect(error.message).toContain("100");
  });
});

describe("runtime execution mode", () => {
  it("normalizes valid names and returns null for empty or unknown values", () => {
    expect(normalizeRuntimeExecutionMode("cloud")).toBe("cloud");
    expect(normalizeRuntimeExecutionMode("  CLOUD  ")).toBe("cloud");
    expect(normalizeRuntimeExecutionMode("local-safe")).toBe("local-safe");
    expect(normalizeRuntimeExecutionMode("LOCAL-YOLO")).toBe("local-yolo");
    expect(normalizeRuntimeExecutionMode("")).toBeNull();
    expect(normalizeRuntimeExecutionMode("nope")).toBeNull();
    expect(normalizeRuntimeExecutionMode(undefined)).toBeNull();
    expect(normalizeRuntimeExecutionMode(42)).toBeNull();
  });

  it("classifies cloud vs local-safe vs local-yolo predicates", () => {
    expect(RUNTIME_EXECUTION_MODES).toEqual([
      "cloud",
      "local-safe",
      "local-yolo",
    ]);
    expect(isCloudRuntimeMode("cloud")).toBe(true);
    expect(isCloudRuntimeMode("local-safe")).toBe(false);
    expect(isLocalRuntimeMode("local-safe")).toBe(true);
    expect(isLocalRuntimeMode("local-yolo")).toBe(true);
    expect(isLocalRuntimeMode("cloud")).toBe(false);
    expect(isSafeLocalMode("local-safe")).toBe(true);
    expect(isYoloLocalMode("local-yolo")).toBe(true);
    expect(isYoloLocalMode("local-safe")).toBe(false);
    expect(RUNTIME_EXECUTION_MODE_DEFINITIONS.cloud).toEqual({
      mode: "cloud",
      local: false,
      cloud: true,
      safe: true,
      yolo: false,
    });
  });

  it("falls back from an empty config to local-safe, honors a single explicit mode, and ignores invalid overflow", () => {
    expect(readRuntimeExecutionModeConfig({})).toBe("local-safe");
    expect(readRuntimeExecutionModeConfig(null)).toBe("local-safe");
    expect(
      readRuntimeExecutionModeConfig({ runtime: { executionMode: "cloud" } }),
    ).toBe("cloud");
    expect(
      readRuntimeExecutionModeConfig({
        runtime: { executionMode: "nope" },
        deploymentTarget: { runtime: "cloud" },
      }),
    ).toBe("cloud");
    expect(runtimeExecutionModeForDeploymentTarget(undefined)).toBe(
      "local-safe",
    );
    expect(runtimeExecutionModeForDeploymentTarget({ runtime: "cloud" })).toBe(
      "cloud",
    );
  });
});

describe("resolveDistributionProfile", () => {
  it("defaults missing or blank env to unrestricted and parses store case-insensitively", () => {
    expect(resolveDistributionProfile({})).toBe("unrestricted");
    expect(
      resolveDistributionProfile({ ELIZA_DISTRIBUTION_PROFILE: "  " }),
    ).toBe("unrestricted");
    expect(
      resolveDistributionProfile({ ELIZA_DISTRIBUTION_PROFILE: "  STORE  " }),
    ).toBe("store");
    expect(isDistributionProfile("store")).toBe(true);
    expect(isDistributionProfile("STORE")).toBe(false);
    expect(isDistributionProfile("unrestricted")).toBe(true);
    expect(isDistributionProfile(1)).toBe(false);
  });

  it("throws on an unknown profile instead of falling through", () => {
    expect(() =>
      resolveDistributionProfile({ ELIZA_DISTRIBUTION_PROFILE: "beta" }),
    ).toThrow(/ELIZA_DISTRIBUTION_PROFILE=beta/);
  });
});

describe("shouldUseCloudOnlyBranding", () => {
  it("lets an explicit desktop cloud mode win over dev and injected backends", () => {
    expect(
      shouldUseCloudOnlyBranding({
        isDev: true,
        injectedApiBase: "http://127.0.0.1:3000",
        desktopRuntimeMode: "  CLOUD  ",
      }),
    ).toBe(true);
    expect(
      shouldUseCloudOnlyBranding({
        isDev: true,
        desktopRuntimeMode: "elizacloud",
      }),
    ).toBe(true);
  });

  it("returns false for dev or an injected backend, and true for production web", () => {
    expect(shouldUseCloudOnlyBranding({ isDev: true })).toBe(false);
    expect(
      shouldUseCloudOnlyBranding({
        isDev: false,
        injectedApiBase: " http://127.0.0.1:3000 ",
      }),
    ).toBe(false);
    expect(shouldUseCloudOnlyBranding({ isDev: false })).toBe(true);
  });

  it("on native platforms follows nativeRuntimeMode cloud/elizacloud only", () => {
    expect(
      shouldUseCloudOnlyBranding({
        isDev: false,
        isNativePlatform: true,
        nativeRuntimeMode: "cloud",
      }),
    ).toBe(true);
    expect(
      shouldUseCloudOnlyBranding({
        isDev: false,
        isNativePlatform: true,
        nativeRuntimeMode: "local",
      }),
    ).toBe(false);
  });
});

describe("type guards", () => {
  it("accepts plain objects and rejects null, arrays, and class instances", () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject({ a: 1 })).toBe(true);
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject(new Date())).toBe(false);
  });

  it("narrows records, object arrays, and non-empty strings across empty/single/missing inputs", () => {
    expect(asRecord(null)).toBeNull();
    expect(asRecord([])).toBeNull();
    expect(asRecord({ a: 1 })).toEqual({ a: 1 });
    expect(asRecordOrUndefined(undefined)).toBeUndefined();
    expect(asObjectArray(undefined)).toEqual([]);
    expect(asObjectArray([{ id: 1 }, "skip", null, { id: 2 }])).toEqual([
      { id: 1 },
      { id: 2 },
    ]);
    expect(asNonEmptyString("  ")).toBeUndefined();
    expect(asNonEmptyString("  eliza  ")).toBe("eliza");
    expect(asNonEmptyString(1)).toBeUndefined();
  });
});

describe("config path parse / get / set / unset", () => {
  it("rejects empty, over-long, and prototype-polluting paths", () => {
    expect(parseConfigPath("")).toEqual({
      ok: false,
      error: "Invalid path. Use dot notation (e.g. foo.bar).",
    });
    expect(parseConfigPath("   ")).toEqual({
      ok: false,
      error: "Invalid path. Use dot notation (e.g. foo.bar).",
    });
    expect(
      parseConfigPath(Array.from({ length: 40 }, () => "a").join(".")).ok,
    ).toBe(false);
    expect(parseConfigPath("__proto__.polluted")).toEqual({
      ok: false,
      error: "Invalid path segment.",
    });
    expect(parseConfigPath("constructor")).toEqual({
      ok: false,
      error: "Invalid path segment.",
    });
  });

  it("gets undefined for a missing path and round-trips a single nested value", () => {
    const root: Record<string, unknown> = {};
    expect(getConfigValueAtPath(root, ["models", "large"])).toBeUndefined();
    setConfigValueAtPath(root, ["models", "large"], "claude-sonnet");
    expect(getConfigValueAtPath(root, ["models", "large"])).toBe(
      "claude-sonnet",
    );
    expect(unsetConfigValueAtPath(root, ["models", "missing"])).toBe(false);
    expect(unsetConfigValueAtPath(root, ["models", "large"])).toBe(true);
    expect(getConfigValueAtPath(root, ["models", "large"])).toBeUndefined();
    expect(root).toEqual({});
  });
});

describe("in-memory config overrides", () => {
  it("returns the same config object when the override tree is empty", () => {
    const cfg: ElizaConfig = { logging: { level: "info" } };
    expect(applyConfigOverrides(cfg)).toBe(cfg);
    expect(getConfigOverrides()).toEqual({});
  });

  it("merges a single nested override without dropping sibling keys", () => {
    const cfg: ElizaConfig = {
      models: { small: "haiku", large: "sonnet" },
    };
    expect(setConfigOverride("models.large", "opus")).toEqual({ ok: true });
    const next = applyConfigOverrides(cfg);
    expect(next).not.toBe(cfg);
    expect(next.models).toEqual({ small: "haiku", large: "opus" });
    expect(cfg.models).toEqual({ small: "haiku", large: "sonnet" });
  });

  it("refuses an unsafe path and reports removed=false for a missing item", () => {
    expect(setConfigOverride("", 1).ok).toBe(false);
    expect(setConfigOverride("__proto__.x", 1)).toEqual({
      ok: false,
      error: "Invalid path segment.",
    });
    expect(unsetConfigOverride("does.not.exist")).toEqual({
      ok: true,
      removed: false,
    });
    expect(setConfigOverride("logging.level", "debug")).toEqual({ ok: true });
    expect(unsetConfigOverride("logging.level")).toEqual({
      ok: true,
      removed: true,
    });
  });
});

describe("parseAllowedHostEnv", () => {
  it("treats nullish or empty configuration as an empty queue", () => {
    expect(parseAllowedHostEnv(undefined)).toEqual([]);
    expect(parseAllowedHostEnv(null)).toEqual([]);
    expect(parseAllowedHostEnv("  ,  ")).toEqual([]);
  });

  it("parses a single host and deduplicates overflow equivalents", () => {
    expect(parseAllowedHostEnv("Example.COM")).toEqual([
      { host: "example.com", includeSubdomains: false },
    ]);
    expect(
      parseAllowedHostEnv("example.com, EXAMPLE.com, example.com"),
    ).toEqual([{ host: "example.com", includeSubdomains: false }]);
  });
});

describe("chat upload limits", () => {
  it("derives raw-byte caps from the base64 ceiling and keeps MIME sets disjoint by kind", () => {
    expect(MAX_CHAT_UPLOAD_ATTACHMENTS).toBe(4);
    expect(maxRawBytesForBase64(0)).toBe(0);
    expect(maxRawBytesForBase64(4)).toBe(3);
    expect(maxRawBytesForBase64(5)).toBe(3);
    expect(maxRawBytesForBase64(8)).toBe(6);
    expect(MAX_CHAT_IMAGE_RAW_BYTES).toBe(
      maxRawBytesForBase64(MAX_CHAT_IMAGE_BASE64_BYTES),
    );
    expect(CHAT_IMAGE_MIME_TYPE_SET.has("image/jpeg")).toBe(true);
    expect(CHAT_IMAGE_MIME_TYPE_SET.has("audio/mpeg")).toBe(false);
    expect(CHAT_UPLOAD_MIME_TYPE_SET.has("audio/mpeg")).toBe(true);
    expect(CHAT_UPLOAD_MIME_TYPE_SET.has("image/tiff")).toBe(false);
  });
});
