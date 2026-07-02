import { describe, expect, it } from "vitest";
import {
  normalizeCodingBackend,
  readBackendRouting,
} from "./settings-actions.ts";

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
});
