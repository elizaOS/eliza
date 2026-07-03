import { ModelType, satisfiesRoleGate } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  hasLoadedTextProvider,
  normalizeCodingBackend,
  readBackendRouting,
  settingsAction,
} from "./settings-actions.ts";

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
    for (const b of ["elizaos", "pi-agent", "claude", "codex", "opencode"]) {
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
