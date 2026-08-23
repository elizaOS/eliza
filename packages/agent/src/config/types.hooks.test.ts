/**
 * Contract coverage for the config-scoped re-export of `@elizaos/shared`
 * (`types.hooks.ts`). Consumers import HooksConfig, HookMappingConfig,
 * HooksGmailConfig, InternalHooksConfig, and related shapes through this
 * local path. Runtime values re-exported from the same barrel must stay the
 * same identity as `@elizaos/shared`. Deterministic, no mocks.
 */

import {
  AgentDefaultsSchema as SharedAgentDefaultsSchema,
  CONNECTOR_IDS as SharedConnectorIds,
} from "@elizaos/shared";
import { describe, expect, expectTypeOf, it } from "vitest";
import { checkEligibility, resolveHookConfig } from "../hooks/eligibility.ts";
import type { ElizaHookMetadata } from "../hooks/types.ts";
import type {
  HookConfig,
  HookInstallRecord,
  HookMappingConfig,
  HookMappingMatch,
  HookMappingTransform,
  HooksConfig,
  HooksGmailConfig,
  HooksGmailTailscaleMode,
  InternalHookHandlerConfig,
  InternalHooksConfig,
} from "./types.hooks.ts";
import { AgentDefaultsSchema, CONNECTOR_IDS } from "./types.hooks.ts";

const UNIQUE_ENV_KEY = "ELIZA_TYPES_HOOKS_COVERAGE_UNIQUE_ENV";

const BASE_METADATA: ElizaHookMetadata = { events: ["command:new"] };

describe("types.hooks re-export", () => {
  it("re-exports CONNECTOR_IDS from @elizaos/shared by identity", () => {
    expect(CONNECTOR_IDS).toBe(SharedConnectorIds);
  });

  it("re-exports AgentDefaultsSchema from @elizaos/shared by identity", () => {
    expect(AgentDefaultsSchema).toBe(SharedAgentDefaultsSchema);
  });
});

describe("HookMappingMatch and HookMappingTransform", () => {
  it("keeps every match field optional", () => {
    expectTypeOf<HookMappingMatch>().toEqualTypeOf<{
      path?: string;
      source?: string;
    }>();
    const empty: HookMappingMatch = {};
    expect(empty.path).toBeUndefined();
    expect(empty.source).toBeUndefined();
  });

  it("requires transform.module and keeps export optional", () => {
    expectTypeOf<HookMappingTransform>().toEqualTypeOf<{
      module: string;
      export?: string;
    }>();
    const transform: HookMappingTransform = { module: "./wake.ts" };
    expect(transform.module).toBe("./wake.ts");
    expect(transform.export).toBeUndefined();
  });
});

describe("HookMappingConfig", () => {
  it("accepts an empty mapping because every field is optional", () => {
    const empty: HookMappingConfig = {};
    expect(empty.action).toBeUndefined();
    expect(empty.match).toBeUndefined();
    expect(empty.transform).toBeUndefined();
  });

  it("narrows action and wakeMode unions", () => {
    expectTypeOf<HookMappingConfig["action"]>().toEqualTypeOf<
      "wake" | "agent" | undefined
    >();
    expectTypeOf<HookMappingConfig["wakeMode"]>().toEqualTypeOf<
      "now" | "next-heartbeat" | undefined
    >();
    const mapping: HookMappingConfig = {
      action: "wake",
      wakeMode: "next-heartbeat",
    };
    expect(mapping.action).toBe("wake");
    expect(mapping.wakeMode).toBe("next-heartbeat");
  });

  it("narrows the delivery channel union and treats thinking as a free string", () => {
    expectTypeOf<NonNullable<HookMappingConfig["channel"]>>().toEqualTypeOf<
      | "last"
      | "whatsapp"
      | "telegram"
      | "discord"
      | "googlechat"
      | "slack"
      | "imessage"
      | "msteams"
    >();
    expectTypeOf<HookMappingConfig["thinking"]>().toEqualTypeOf<
      string | undefined
    >();
    const mapping: HookMappingConfig = {
      channel: "telegram",
      thinking: "xhigh",
      timeoutSeconds: 0,
    };
    expect(mapping.channel).toBe("telegram");
    expect(mapping.thinking).toBe("xhigh");
    expect(mapping.timeoutSeconds).toBe(0);
  });

  it("stores a single mapping and preserves order including equal-id ties", () => {
    const mappings: HookMappingConfig[] = [
      { id: "dup", name: "first" },
      { id: "dup", name: "second" },
    ];
    expect(mappings).toHaveLength(2);
    expect(mappings.map((item) => item.name)).toEqual(["first", "second"]);
    mappings.splice(0, mappings.length);
    expect(mappings).toEqual([]);
  });
});

describe("HooksGmailConfig", () => {
  it("keeps every gmail field optional, including nested serve/tailscale", () => {
    const empty: HooksGmailConfig = {};
    expect(empty.account).toBeUndefined();
    expect(empty.serve).toBeUndefined();
    expect(empty.tailscale).toBeUndefined();
  });

  it("narrows tailscale mode and gmail thinking unions", () => {
    expectTypeOf<HooksGmailTailscaleMode>().toEqualTypeOf<
      "off" | "serve" | "funnel"
    >();
    expectTypeOf<NonNullable<HooksGmailConfig["thinking"]>>().toEqualTypeOf<
      "off" | "minimal" | "low" | "medium" | "high"
    >();
    const gmail: HooksGmailConfig = {
      tailscale: { mode: "funnel", path: "/hooks", target: "8080" },
      thinking: "minimal",
      maxBytes: 1,
      renewEveryMinutes: 1,
      serve: { port: 1 },
    };
    expect(gmail.tailscale?.mode).toBe("funnel");
    expect(gmail.thinking).toBe("minimal");
  });

  it("allows a zero maxBytes at the type layer (no positive constraint here)", () => {
    const gmail: HooksGmailConfig = { maxBytes: 0, renewEveryMinutes: 0 };
    expect(gmail.maxBytes).toBe(0);
    expect(gmail.renewEveryMinutes).toBe(0);
  });
});

describe("InternalHookHandlerConfig and HookInstallRecord", () => {
  it("requires handler event and module", () => {
    expectTypeOf<InternalHookHandlerConfig>().toEqualTypeOf<{
      event: string;
      module: string;
      export?: string;
    }>();
    const handler: InternalHookHandlerConfig = {
      event: "command:new",
      module: "./handler.ts",
    };
    expect(handler.event).toBe("command:new");
    expect(handler.export).toBeUndefined();
  });

  it("requires install source and keeps hook lists empty, single, or ordered", () => {
    expectTypeOf<HookInstallRecord["source"]>().toEqualTypeOf<
      "npm" | "archive" | "path"
    >();
    const emptyHooks: HookInstallRecord = { source: "path", hooks: [] };
    expect(emptyHooks.hooks).toEqual([]);
    const one: HookInstallRecord = {
      source: "npm",
      spec: "pack@1",
      hooks: ["a"],
    };
    expect(one.hooks).toEqual(["a"]);
    const ordered: HookInstallRecord = {
      source: "archive",
      hooks: ["b", "a", "b"],
    };
    expect(ordered.hooks).toEqual(["b", "a", "b"]);
  });
});

describe("HookConfig index signature", () => {
  it("keeps enabled and env optional and allows extra keys", () => {
    const empty: HookConfig = {};
    expect(empty.enabled).toBeUndefined();
    expect(empty.env).toBeUndefined();
    const extra: HookConfig = { enabled: true, custom: 1 };
    expect(extra.enabled).toBe(true);
    expect(extra.custom).toBe(1);
  });

  it("treats an empty env map as a missing lookup for every key", () => {
    const hook: HookConfig = { env: {} };
    expect(Object.keys(hook.env ?? {})).toEqual([]);
    expect(hook.env?.HOOK_TOKEN).toBeUndefined();
  });
});

describe("InternalHooksConfig", () => {
  it("accepts an empty internal block because every field is optional", () => {
    const empty: InternalHooksConfig = {};
    expect(empty.handlers).toBeUndefined();
    expect(empty.entries).toBeUndefined();
    expect(empty.installs).toBeUndefined();
  });

  it("preserves handler queue order, including adjacent event ties", () => {
    const internal: InternalHooksConfig = {
      handlers: [
        { event: "command:new", module: "./a.ts" },
        { event: "command:new", module: "./b.ts" },
      ],
      load: { extraDirs: [] },
    };
    expect(internal.handlers?.map((handler) => handler.module)).toEqual([
      "./a.ts",
      "./b.ts",
    ]);
    expect(internal.load?.extraDirs).toEqual([]);
  });

  it("stores a single extraDir and a missing-key install lookup as undefined", () => {
    const internal: InternalHooksConfig = {
      load: { extraDirs: ["/hooks"] },
      installs: { pack: { source: "path" } },
    };
    expect(internal.load?.extraDirs).toEqual(["/hooks"]);
    expect(internal.installs?.pack?.source).toBe("path");
    expect(internal.installs?.missing).toBeUndefined();
    delete internal.installs?.missing;
    expect(internal.installs?.missing).toBeUndefined();
    expect(Object.keys(internal.installs ?? {})).toEqual(["pack"]);
  });
});

describe("HooksConfig", () => {
  it("accepts an empty hooks object because every field is optional", () => {
    const empty: HooksConfig = {};
    expect(empty.mappings).toBeUndefined();
    expect(empty.gmail).toBeUndefined();
    expect(empty.internal).toBeUndefined();
  });

  it("accepts an empty mappings queue, a single mapping, and overflow order", () => {
    const none: HooksConfig = { mappings: [] };
    expect(none.mappings).toEqual([]);
    const one: HooksConfig = { mappings: [{ id: "only", action: "agent" }] };
    expect(one.mappings).toHaveLength(1);
    const overflow: HooksConfig = {
      mappings: Array.from({ length: 12 }, (_, index) => ({
        id: `m-${index}`,
      })),
      presets: ["a", "b"],
      maxBodyBytes: 0,
    };
    expect(overflow.mappings).toHaveLength(12);
    expect(overflow.mappings?.[0]?.id).toBe("m-0");
    expect(overflow.mappings?.[11]?.id).toBe("m-11");
    expect(overflow.maxBodyBytes).toBe(0);
  });
});

describe("resolveHookConfig against InternalHooksConfig.entries", () => {
  it("returns undefined for a missing config, empty entries, or a missing key", () => {
    expect(resolveHookConfig(undefined, "gmail")).toBeUndefined();
    expect(resolveHookConfig({}, "gmail")).toBeUndefined();
    expect(resolveHookConfig({ entries: {} }, "gmail")).toBeUndefined();
    expect(
      resolveHookConfig({ entries: { other: { enabled: true } } }, "gmail"),
    ).toBeUndefined();
  });

  it("returns the single stored entry and leaves other keys missing", () => {
    const internal: InternalHooksConfig = {
      entries: { gmail: { enabled: true, env: { TOKEN: "x" } } },
    };
    expect(resolveHookConfig(internal, "gmail")).toEqual({
      enabled: true,
      env: { TOKEN: "x" },
    });
    expect(resolveHookConfig(internal, "slack")).toBeUndefined();
  });

  it("preserves insertion order of entry keys when looking up one of several", () => {
    const internal: InternalHooksConfig = {
      entries: {
        telegram: { enabled: false },
        gmail: { enabled: true },
        discord: { enabled: true },
      },
    };
    expect(Object.keys(internal.entries ?? {})).toEqual([
      "telegram",
      "gmail",
      "discord",
    ]);
    expect(resolveHookConfig(internal, "gmail")?.enabled).toBe(true);
  });
});

describe("checkEligibility against HookConfig", () => {
  it("treats missing metadata as eligible regardless of hookConfig", () => {
    expect(checkEligibility(undefined, undefined)).toEqual({
      eligible: true,
      missing: [],
    });
    expect(checkEligibility(undefined, { enabled: false })).toEqual({
      eligible: true,
      missing: [],
    });
  });

  it("does not treat enabled=false as ineligible", () => {
    expect(checkEligibility(BASE_METADATA, { enabled: false })).toEqual({
      eligible: true,
      missing: [],
    });
  });

  it("accepts a required env var from HookConfig.env when process.env lacks it", () => {
    const previous = process.env[UNIQUE_ENV_KEY];
    delete process.env[UNIQUE_ENV_KEY];
    try {
      const requiresEnv: ElizaHookMetadata = {
        events: ["command:new"],
        requires: { env: [UNIQUE_ENV_KEY] },
      };
      expect(checkEligibility(requiresEnv, {})).toEqual({
        eligible: false,
        missing: [`Env missing: ${UNIQUE_ENV_KEY}`],
      });
      expect(
        checkEligibility(requiresEnv, { env: { [UNIQUE_ENV_KEY]: "set" } }),
      ).toEqual({ eligible: true, missing: [] });
    } finally {
      if (previous === undefined) {
        delete process.env[UNIQUE_ENV_KEY];
      } else {
        process.env[UNIQUE_ENV_KEY] = previous;
      }
    }
  });
});
