import { satisfiesRoleGate } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
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
});
