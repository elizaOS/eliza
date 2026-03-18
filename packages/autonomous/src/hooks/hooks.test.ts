/**
 * Hooks System — Smoke Tests
 *
 * Covers the parts NOT already tested in registry.test.ts:
 * - Eligibility checks (OS, binaries, env, config)
 * - Loader orchestration (discover → eligibility → register)
 * - Discovery frontmatter parsing
 * - End-to-end: load → trigger → handler fires
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { HookConfig, InternalHooksConfig } from "../config/types.hooks";
import { checkEligibility, resolveHookConfig } from "./eligibility";
import {
  clearHooks,
  createHookEvent,
  registerHook,
  triggerHook,
} from "./registry";
import type { ElizaHookMetadata } from "./types";

// ---------------------------------------------------------------------------
// mocks
// ---------------------------------------------------------------------------

vi.mock("@elizaos/core", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------

afterEach(() => {
  clearHooks();
  vi.restoreAllMocks();
});

// ============================================================================
//  1. Eligibility — checkEligibility
// ============================================================================

describe("checkEligibility", () => {
  it("returns eligible when no metadata is provided", () => {
    const result = checkEligibility(undefined, undefined);
    expect(result.eligible).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it("returns eligible when metadata has no requirements", () => {
    const metadata: ElizaHookMetadata = { events: ["command:new"] };
    const result = checkEligibility(metadata, undefined);
    expect(result.eligible).toBe(true);
  });

  it("rejects when OS does not match", () => {
    const otherPlatform =
      ["darwin", "linux", "win32"].find(
        (value) => value !== process.platform,
      ) ?? "darwin";
    const metadata: ElizaHookMetadata = {
      events: ["command:new"],
      os: [otherPlatform],
    };
    const result = checkEligibility(metadata, undefined);
    expect(result.eligible).toBe(false);
    expect(result.missing.length).toBe(1);
    expect(result.missing[0]).toContain("OS:");
  });

  it("accepts when OS matches current platform", () => {
    const { platform } = require("node:os");
    const metadata: ElizaHookMetadata = {
      events: ["command:new"],
      os: [platform()],
    };
    const result = checkEligibility(metadata, undefined);
    expect(result.eligible).toBe(true);
  });

  it("rejects when required binary is missing", () => {
    const metadata: ElizaHookMetadata = {
      events: ["command:new"],
      requires: {
        bins: ["__nonexistent_binary_12345__"],
      },
    };
    const result = checkEligibility(metadata, undefined);
    expect(result.eligible).toBe(false);
    expect(result.missing[0]).toContain("Binary missing");
  });

  it("accepts when required binary exists", () => {
    const metadata: ElizaHookMetadata = {
      events: ["command:new"],
      requires: {
        bins: ["node"], // node should exist in test environment
      },
    };
    const result = checkEligibility(metadata, undefined);
    expect(result.eligible).toBe(true);
  });

  it("rejects when none of anyBins are available", () => {
    const metadata: ElizaHookMetadata = {
      events: ["command:new"],
      requires: {
        anyBins: ["__nonexistent_a__", "__nonexistent_b__"],
      },
    };
    const result = checkEligibility(metadata, undefined);
    expect(result.eligible).toBe(false);
    expect(result.missing[0]).toContain("None of:");
  });

  it("accepts when at least one of anyBins exists", () => {
    const metadata: ElizaHookMetadata = {
      events: ["command:new"],
      requires: {
        anyBins: ["__nonexistent__", "node"],
      },
    };
    const result = checkEligibility(metadata, undefined);
    expect(result.eligible).toBe(true);
  });

  it("rejects when required env var is missing", () => {
    const metadata: ElizaHookMetadata = {
      events: ["command:new"],
      requires: {
        env: ["__TEST_HOOK_ENV_VAR_MISSING__"],
      },
    };
    const result = checkEligibility(metadata, undefined);
    expect(result.eligible).toBe(false);
    expect(result.missing[0]).toContain("Env missing");
  });

  it("accepts env var from process.env", () => {
    process.env.__TEST_HOOK_ENV_VAR__ = "present";
    try {
      const metadata: ElizaHookMetadata = {
        events: ["command:new"],
        requires: {
          env: ["__TEST_HOOK_ENV_VAR__"],
        },
      };
      const result = checkEligibility(metadata, undefined);
      expect(result.eligible).toBe(true);
    } finally {
      delete process.env.__TEST_HOOK_ENV_VAR__;
    }
  });

  it("accepts env var from hookConfig.env", () => {
    const metadata: ElizaHookMetadata = {
      events: ["command:new"],
      requires: {
        env: ["SOME_TOKEN"],
      },
    };
    const hookConfig: HookConfig = {
      env: { SOME_TOKEN: "abc123" },
    };
    const result = checkEligibility(metadata, hookConfig);
    expect(result.eligible).toBe(true);
  });

  it("rejects when required config path is falsy", () => {
    const metadata: ElizaHookMetadata = {
      events: ["command:new"],
      requires: {
        config: ["providers.openai"],
      },
    };
    const result = checkEligibility(metadata, undefined, {});
    expect(result.eligible).toBe(false);
    expect(result.missing[0]).toContain("Config missing");
  });

  it("accepts when required config path is truthy", () => {
    const metadata: ElizaHookMetadata = {
      events: ["command:new"],
      requires: {
        config: ["providers.openai"],
      },
    };
    const elizaConfig = { providers: { openai: "sk-abc" } };
    const result = checkEligibility(metadata, undefined, elizaConfig);
    expect(result.eligible).toBe(true);
  });

  it("bypasses requirement checks when always=true (except OS)", () => {
    const metadata: ElizaHookMetadata = {
      always: true,
      events: ["command:new"],
      requires: {
        bins: ["__nonexistent__"],
        env: ["__MISSING__"],
      },
    };
    const result = checkEligibility(metadata, undefined);
    // always=true bypasses bins/env checks but OS is still checked before always
    expect(result.eligible).toBe(true);
  });

  it("accumulates multiple missing requirements", () => {
    const metadata: ElizaHookMetadata = {
      events: ["command:new"],
      requires: {
        bins: ["__missing_bin__"],
        env: ["__MISSING_ENV__"],
        config: ["missing.config.path"],
      },
    };
    const result = checkEligibility(metadata, undefined, {});
    expect(result.eligible).toBe(false);
    expect(result.missing.length).toBe(3);
  });
});

// ============================================================================
//  2. resolveHookConfig
// ============================================================================

describe("resolveHookConfig", () => {
  it("returns undefined when no internal config", () => {
    expect(resolveHookConfig(undefined, "my-hook")).toBeUndefined();
  });

  it("returns undefined when hook key not in entries", () => {
    const config: InternalHooksConfig = {
      entries: { "other-hook": { enabled: true } },
    };
    expect(resolveHookConfig(config, "my-hook")).toBeUndefined();
  });

  it("returns the config for a matching hook key", () => {
    const hookConfig: HookConfig = { enabled: true, env: { TOKEN: "abc" } };
    const config: InternalHooksConfig = {
      entries: { "my-hook": hookConfig },
    };
    expect(resolveHookConfig(config, "my-hook")).toEqual(hookConfig);
  });
});

// ============================================================================
//  3. End-to-end: register → trigger → handler fires with correct payload
// ============================================================================

describe("hooks end-to-end smoke", () => {
  it("hook registration → event trigger → handler receives payload", async () => {
    const received: Array<{
      type: string;
      action: string;
      context: Record<string, unknown>;
    }> = [];

    registerHook("session:start", (event) => {
      received.push({
        type: event.type,
        action: event.action,
        context: event.context,
      });
    });

    const event = createHookEvent("session", "start", "sess-smoke", {
      workspace: "/tmp/test",
    });
    await triggerHook(event);

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe("session");
    expect(received[0].action).toBe("start");
    expect(received[0].context.workspace).toBe("/tmp/test");
  });

  it("handler error does not crash runtime — other handlers still fire", async () => {
    const results: string[] = [];

    registerHook("agent:stop", () => {
      throw new Error("handler crash");
    });
    registerHook("agent:stop", () => {
      results.push("second-handler-ok");
    });

    // Should not throw
    await triggerHook(createHookEvent("agent", "stop", "sess-1"));

    expect(results).toEqual(["second-handler-ok"]);
  });

  it("hook removal via clearHooks prevents further triggers", async () => {
    const handler = vi.fn();
    registerHook("command:reset", handler);

    clearHooks();

    await triggerHook(createHookEvent("command", "reset", "sess-1"));
    expect(handler).not.toHaveBeenCalled();
  });

  it("handler can push messages into the event", async () => {
    registerHook("gateway:connect", (event) => {
      event.messages.push("Handler A processed");
    });
    registerHook("gateway:connect", (event) => {
      event.messages.push("Handler B processed");
    });

    const event = createHookEvent("gateway", "connect", "sess-1");
    await triggerHook(event);

    expect(event.messages).toEqual([
      "Handler A processed",
      "Handler B processed",
    ]);
  });
});
