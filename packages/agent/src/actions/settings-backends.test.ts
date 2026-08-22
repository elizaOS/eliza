/**
 * Covers the owner-only role gate on the SETTINGS action's backend ops
 * (show_backends / set_backend) alongside the pure helpers behind them:
 * coding-backend normalization and aliasing, ELIZA_BACKEND_ROUTING parsing
 * (including the operator allow lock-list), loaded text-provider detection, and
 * set_backend refusal to persist a backend outside the effective allow-list.
 * Deterministic: assertions against helpers and stub runtimes, no live model.
 */
import { ModelType, satisfiesRoleGate } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const configHarness = vi.hoisted(() => ({
  config: { env: {} as Record<string, unknown> },
  save: vi.fn(),
}));

vi.mock("../config/config.ts", () => ({
  loadElizaConfig: () => configHarness.config,
  saveElizaConfig: configHarness.save,
}));

import {
  hasLoadedTextProvider,
  normalizeCodingBackend,
  readBackendRouting,
  settingsAction,
} from "./settings-actions.ts";

beforeEach(() => {
  configHarness.config.env = {};
  configHarness.save.mockClear();
});

afterEach(() => {
  for (const key of [
    "ELIZA_DEFAULT_AGENT_TYPE",
    "ELIZA_CODEX_MODEL_POWERFUL",
    "ELIZA_CODEX_MODEL_FAST",
    "ELIZA_CODING_FALLBACK_BACKENDS",
    "ELIZA_DEFAULT_APPROVAL_PRESET",
    "ELIZA_CODING_ACCOUNT_STRATEGY",
    "ELIZA_CODING_ACCOUNT_IDS",
    "ELIZA_CODING_ACCOUNT_PROVIDER",
    "ELIZA_CODING_BILLING_MODE",
  ]) {
    delete process.env[key];
  }
});

describe("owner gate on SETTINGS (show_backends / set_backend)", () => {
  // show_backends/set_backend are ops of the SETTINGS action, whose roleGate
  // core enforces structurally (satisfiesRoleGate in execute-planned-tool-call)
  // before the handler runs. Pair the declared gate with the enforcing
  // predicate so a gate regression on either side fails here.
  it("declares an OWNER-minimum role gate", () => {
    expect(settingsAction.roleGate).toEqual({ minRole: "OWNER" });
  });

  it("denies every non-owner role under the enforcing predicate", () => {
    expect(satisfiesRoleGate(undefined, settingsAction.roleGate)).toBe(false);
    for (const roles of [[], ["GUEST"], ["USER"], ["MEMBER"], ["ADMIN"]]) {
      expect(
        satisfiesRoleGate(
          roles as Parameters<typeof satisfiesRoleGate>[0],
          settingsAction.roleGate,
        ),
      ).toBe(false);
    }
  });

  it("allows the owner", () => {
    expect(
      satisfiesRoleGate(
        ["OWNER"] as Parameters<typeof satisfiesRoleGate>[0],
        settingsAction.roleGate,
      ),
    ).toBe(true);
  });
});

describe("normalizeCodingBackend", () => {
  it("accepts known coding backends", () => {
    for (const b of [
      "elizaos",
      "pi-agent",
      "claude",
      "codex",
      "opencode",
      "kimi",
      "grok",
    ]) {
      expect(normalizeCodingBackend(b)).toBe(b);
    }
  });

  it("resolves aliases", () => {
    expect(normalizeCodingBackend("openai")).toBe("codex");
    expect(normalizeCodingBackend("claude-code")).toBe("claude");
    expect(normalizeCodingBackend("eliza")).toBe("elizaos");
    expect(normalizeCodingBackend("open_code")).toBe("opencode");
    expect(normalizeCodingBackend("PI")).toBe("pi-agent");
  });

  it("rejects unknown / empty / non-string", () => {
    expect(normalizeCodingBackend("gpt-9000")).toBeUndefined();
    expect(normalizeCodingBackend("")).toBeUndefined();
    expect(normalizeCodingBackend(undefined)).toBeUndefined();
    expect(normalizeCodingBackend(42)).toBeUndefined();
  });
});

describe("readBackendRouting", () => {
  it("returns empty routing for missing config", () => {
    expect(readBackendRouting({})).toEqual({});
    expect(readBackendRouting({ env: {} })).toEqual({});
  });

  it("parses a JSON-string ELIZA_BACKEND_ROUTING", () => {
    const routing = readBackendRouting({
      env: {
        ELIZA_BACKEND_ROUTING: JSON.stringify({
          coding: { default: "codex", byTag: { Hard: "claude" } },
        }),
      },
    });
    expect(routing.default).toBe("codex");
    expect(routing.byTag).toEqual({ hard: "claude" });
  });

  it("parses an object ELIZA_BACKEND_ROUTING", () => {
    const routing = readBackendRouting({
      env: { ELIZA_BACKEND_ROUTING: { coding: { default: "opencode" } } },
    });
    expect(routing.default).toBe("opencode");
  });

  it("ignores malformed JSON", () => {
    expect(
      readBackendRouting({ env: { ELIZA_BACKEND_ROUTING: "{not json" } }),
    ).toEqual({});
  });

  it("carries the operator allow lock-list", () => {
    const routing = readBackendRouting({
      env: {
        ELIZA_BACKEND_ROUTING: JSON.stringify({
          coding: { default: "claude", allow: ["claude", "codex"] },
        }),
      },
    });
    expect(routing.allow).toEqual(["claude", "codex"]);
  });

  it("drops non-string entries from allow", () => {
    const routing = readBackendRouting({
      env: {
        ELIZA_BACKEND_ROUTING: JSON.stringify({
          coding: { allow: ["claude", 42, null, "codex"] },
        }),
      },
    });
    expect(routing.allow).toEqual(["claude", "codex"]);
  });

  it("preserves an explicitly empty allow lock-list", () => {
    const routing = readBackendRouting({
      env: { ELIZA_BACKEND_ROUTING: { coding: { allow: [] } } },
    });
    expect(routing.allow).toEqual([]);
  });
});

describe("hasLoadedTextProvider", () => {
  it("detects registered text-generation handlers by provider", () => {
    const runtime = {
      models: new Map([
        [ModelType.TEXT_LARGE, [{ provider: "anthropic" }]],
        [ModelType.TEXT_EMBEDDING, [{ provider: "cerebras" }]],
      ]),
    };

    expect(hasLoadedTextProvider(runtime as never, "anthropic")).toBe(true);
    expect(hasLoadedTextProvider(runtime as never, "cerebras")).toBe(false);
    expect(hasLoadedTextProvider({} as never, "anthropic")).toBe(false);
  });
});

describe("set_backend allow-list enforcement", () => {
  it("does not persist a backend outside the effective coding allow-list", async () => {
    const runtime = {
      character: {
        settings: {
          routing: { coding: { allow: ["claude"] } },
        },
      },
    };

    const result = await settingsAction.handler(
      runtime as never,
      { entityId: "owner" } as never,
      undefined,
      { parameters: { action: "set_backend", backend: "opencode" } } as never,
    );

    expect(result?.success).toBe(false);
    expect(result?.data?.error).toBe("SETTINGS_BACKEND_DISALLOWED");
    expect(
      (
        runtime.character.settings.routing.coding as {
          default?: string;
        }
      ).default,
    ).toBeUndefined();
  });
});

describe("SETTINGS full coding policy", () => {
  const parameters = {
    action: "set_backend",
    axis: "coding",
    backend: "codex",
    model: "gpt-5.6-sol",
    fastModel: "gpt-5.6-luna",
    fallbackBackends: ["claude", "opencode"],
    approvalPreset: "standard",
    accountStrategy: "quota-aware",
    accountIds: ["acct-primary", "acct-backup"],
    accountProvider: "openai-codex",
    billingMode: "subscription-plus-overage",
  };

  it.each(["chat", "voice"])(
    "uses the same validated atomic policy contract from %s",
    async (source) => {
      const runtime = { character: { settings: {} } };
      const result = await settingsAction.handler(
        runtime as never,
        { entityId: "owner", content: { source } } as never,
        undefined,
        { parameters } as never,
      );

      expect(result?.success).toBe(true);
      expect(configHarness.save).toHaveBeenCalledTimes(1);
      expect(configHarness.config.env).toMatchObject({
        ELIZA_DEFAULT_AGENT_TYPE: "codex",
        ELIZA_CODEX_MODEL_POWERFUL: "gpt-5.6-sol",
        ELIZA_CODEX_MODEL_FAST: "gpt-5.6-luna",
        ELIZA_CODING_FALLBACK_BACKENDS: "claude,opencode",
        ELIZA_CODING_ACCOUNT_PROVIDER: "openai-codex",
        ELIZA_CODING_ACCOUNT_IDS: "acct-primary,acct-backup",
        ELIZA_CODING_BILLING_MODE: "subscription-plus-overage",
      });
      expect(JSON.stringify(result?.data)).not.toContain("credential");
      expect(JSON.stringify(result?.data)).not.toContain("apiKey");
    },
  );

  it("shows the effective non-secret policy", async () => {
    configHarness.config.env = {
      ELIZA_DEFAULT_AGENT_TYPE: "codex",
      ELIZA_CODEX_MODEL_POWERFUL: "gpt-5.6-sol",
      ELIZA_CODEX_MODEL_FAST: "gpt-5.6-luna",
      ELIZA_CODING_FALLBACK_BACKENDS: "claude,opencode",
      ELIZA_DEFAULT_APPROVAL_PRESET: "standard",
      ELIZA_CODING_ACCOUNT_PROVIDER: "openai-codex",
      ELIZA_CODING_ACCOUNT_STRATEGY: "quota-aware",
      ELIZA_CODING_ACCOUNT_IDS: "acct-primary,acct-backup",
      ELIZA_CODING_BILLING_MODE: "subscription-plus-overage",
    };
    const result = await settingsAction.handler(
      { character: { settings: {} } } as never,
      { entityId: "owner" } as never,
      undefined,
      { parameters: { action: "show_backends" } } as never,
    );

    expect(result?.text).toContain("powerful model: gpt-5.6-sol");
    expect(result?.text).toContain("fallback order: claude,opencode");
    expect(result?.text).toContain("billing: subscription-plus-overage");
    expect(result?.data?.policy).toEqual({
      backend: "codex",
      powerfulModel: "gpt-5.6-sol",
      fastModel: "gpt-5.6-luna",
      fallbackBackends: ["claude", "opencode"],
      approvalPreset: "standard",
      accountProvider: "openai-codex",
      accountStrategy: "quota-aware",
      accountIds: ["acct-primary", "acct-backup"],
      billingMode: "subscription-plus-overage",
    });
    expect(JSON.stringify(result?.data)).not.toContain("credential");
    expect(JSON.stringify(result?.data)).not.toContain("apiKey");
  });

  it("rejects an incompatible account provider before saving", async () => {
    const result = await settingsAction.handler(
      { character: { settings: {} } } as never,
      { entityId: "owner" } as never,
      undefined,
      {
        parameters: {
          ...parameters,
          accountProvider: "anthropic-subscription",
        },
      } as never,
    );

    expect(result?.success).toBe(false);
    expect(configHarness.save).not.toHaveBeenCalled();
  });
});
