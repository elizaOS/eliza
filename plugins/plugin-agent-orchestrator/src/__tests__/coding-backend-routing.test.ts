/**
 * Verifies readCodingRouting.
 * Deterministic unit test of pure helpers; no runtime, no live model.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readCodingRouting,
  resolveCodingBackend,
} from "../services/coding-backend-routing.js";

// Env keys resolvePinnedAdapter consults — cleared so tests control the pin
// purely through the fake runtime's getSetting.
const PIN_ENV_KEYS = [
  "BENCHMARK_TASK_AGENT",
  "ELIZA_ACP_DEFAULT_AGENT",
  "ELIZA_DEFAULT_AGENT_TYPE",
  "ELIZA_AGENT_SELECTION_STRATEGY",
  "ELIZA_BACKEND_ROUTING",
];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of PIN_ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of PIN_ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function fakeRuntime(opts: {
  routing?: unknown;
  settings?: Record<string, string>;
}): IAgentRuntime {
  return {
    character: { settings: { routing: opts.routing } },
    getSetting: (key: string) => opts.settings?.[key] ?? null,
  } as unknown as IAgentRuntime;
}

describe("readCodingRouting", () => {
  it("returns undefined for missing / non-object routing", () => {
    expect(readCodingRouting(fakeRuntime({}))).toBeUndefined();
    expect(
      readCodingRouting(fakeRuntime({ routing: "nonsense" })),
    ).toBeUndefined();
    expect(readCodingRouting(fakeRuntime({ routing: [] }))).toBeUndefined();
  });

  it("parses a valid coding axis and lowercases byTag keys", () => {
    const axis = readCodingRouting(
      fakeRuntime({
        routing: {
          coding: { default: "codex", byTag: { Hard: "claude" } },
        },
      }),
    );
    expect(axis?.default).toBe("codex");
    expect(axis?.byTag).toEqual({ hard: "claude" });
  });

  it("parses an allow lock-list", () => {
    const axis = readCodingRouting(
      fakeRuntime({
        routing: { coding: { default: "claude", allow: ["claude", "codex"] } },
      }),
    );
    expect(axis?.allow).toEqual(["claude", "codex"]);
  });

  it("preserves an explicitly empty allow lock-list", () => {
    const axis = readCodingRouting(
      fakeRuntime({
        routing: { coding: { allow: [] } },
      }),
    );
    expect(axis?.allow).toEqual([]);
  });

  it("drops an axis with no usable fields", () => {
    expect(
      readCodingRouting(fakeRuntime({ routing: { coding: { byTag: {} } } })),
    ).toBeUndefined();
  });

  it("falls back to ELIZA_BACKEND_ROUTING env JSON when the character has none", () => {
    process.env.ELIZA_BACKEND_ROUTING = JSON.stringify({
      coding: { default: "codex", byTag: { hard: "claude" } },
    });
    const axis = readCodingRouting(fakeRuntime({}));
    expect(axis?.default).toBe("codex");
    expect(axis?.byTag).toEqual({ hard: "claude" });
  });

  it("reads the env coding axis even when the character declares OTHER routing keys", () => {
    // Per-axis: an unrelated character routing key must not shadow env coding.
    process.env.ELIZA_BACKEND_ROUTING = JSON.stringify({
      coding: { default: "codex" },
    });
    const axis = readCodingRouting(
      fakeRuntime({ routing: { brain: { default: "claude" } } }),
    );
    expect(axis?.default).toBe("codex");
  });

  it("prefers character routing over the env JSON", () => {
    process.env.ELIZA_BACKEND_ROUTING = JSON.stringify({
      coding: { default: "opencode" },
    });
    const axis = readCodingRouting(
      fakeRuntime({ routing: { coding: { default: "codex" } } }),
    );
    expect(axis?.default).toBe("codex");
  });

  it("ignores malformed ELIZA_BACKEND_ROUTING JSON", () => {
    process.env.ELIZA_BACKEND_ROUTING = "{not valid";
    expect(readCodingRouting(fakeRuntime({}))).toBeUndefined();
  });
});

describe("resolveCodingBackend precedence", () => {
  it("1. explicit user ask wins over character routing and pin", () => {
    const runtime = fakeRuntime({
      routing: { coding: { default: "codex", byTag: { hard: "claude" } } },
      settings: { ELIZA_ACP_DEFAULT_AGENT: "opencode" },
    });
    const r = resolveCodingBackend({
      runtime,
      explicit: "claude",
      tag: "simple",
      plannerGuess: "opencode",
    });
    expect(r).toEqual({ agentType: "claude", source: "explicit" });
  });

  it("normalizes explicit aliases (openai -> codex, claude-code -> claude)", () => {
    expect(
      resolveCodingBackend({ runtime: fakeRuntime({}), explicit: "openai" })
        ?.agentType,
    ).toBe("codex");
    expect(
      resolveCodingBackend({
        runtime: fakeRuntime({}),
        explicit: "claude-code",
      })?.agentType,
    ).toBe("claude");
  });

  it("2. character byTag wins over character default and pin", () => {
    const runtime = fakeRuntime({
      routing: { coding: { default: "codex", byTag: { hard: "claude" } } },
      settings: { ELIZA_ACP_DEFAULT_AGENT: "opencode" },
    });
    const r = resolveCodingBackend({
      runtime,
      tag: "hard",
      plannerGuess: "elizaos",
    });
    expect(r).toEqual({ agentType: "claude", source: "character:byTag" });
  });

  it("3. character default applies when the tag has no mapping", () => {
    const runtime = fakeRuntime({
      routing: { coding: { default: "codex", byTag: { hard: "claude" } } },
      settings: { ELIZA_ACP_DEFAULT_AGENT: "opencode" },
    });
    const r = resolveCodingBackend({ runtime, tag: "simple" });
    expect(r).toEqual({ agentType: "codex", source: "character:default" });
  });

  it("labels env byTag/default routing as env-sourced", () => {
    process.env.ELIZA_BACKEND_ROUTING = JSON.stringify({
      coding: { default: "codex", byTag: { hard: "claude" } },
    });

    expect(
      resolveCodingBackend({ runtime: fakeRuntime({}), tag: "hard" }),
    ).toEqual({ agentType: "claude", source: "env:byTag" });
    expect(
      resolveCodingBackend({ runtime: fakeRuntime({}), tag: "simple" }),
    ).toEqual({ agentType: "codex", source: "env:default" });
  });

  it("4. operator pin wins over the planner's heuristic guess", () => {
    const runtime = fakeRuntime({
      settings: { ELIZA_ACP_DEFAULT_AGENT: "opencode" },
    });
    const r = resolveCodingBackend({ runtime, plannerGuess: "claude" });
    expect(r).toEqual({ agentType: "opencode", source: "pin" });
  });

  it("5. planner guess used when nothing more authoritative applies", () => {
    const r = resolveCodingBackend({
      runtime: fakeRuntime({}),
      plannerGuess: "claude",
    });
    expect(r).toEqual({ agentType: "claude", source: "planner" });
  });

  it("6. returns undefined when no signal resolves a known backend", () => {
    expect(resolveCodingBackend({ runtime: fakeRuntime({}) })).toBeUndefined();
    expect(
      resolveCodingBackend({
        runtime: fakeRuntime({}),
        plannerGuess: "garbage",
      }),
    ).toBeUndefined();
  });

  it("ignores an unknown explicit backend and falls through to the pin", () => {
    const runtime = fakeRuntime({
      settings: { ELIZA_ACP_DEFAULT_AGENT: "codex" },
    });
    const r = resolveCodingBackend({ runtime, explicit: "gpt-9000" });
    expect(r).toEqual({ agentType: "codex", source: "pin" });
  });

  it("a non-fixed selection strategy disables the pin", () => {
    const runtime = fakeRuntime({
      settings: {
        ELIZA_ACP_DEFAULT_AGENT: "opencode",
        ELIZA_AGENT_SELECTION_STRATEGY: "dynamic",
      },
    });
    const r = resolveCodingBackend({ runtime, plannerGuess: "claude" });
    expect(r).toEqual({ agentType: "claude", source: "planner" });
  });
});

describe("resolveCodingBackend operator allow lock-list", () => {
  it("rejects an explicit ask outside the allow-list and falls through", () => {
    const runtime = fakeRuntime({
      routing: { coding: { default: "claude", allow: ["claude", "codex"] } },
    });
    // user asks for opencode, but operator locked to claude|codex → skipped,
    // resolution continues to the allowed character default.
    const r = resolveCodingBackend({ runtime, explicit: "opencode" });
    expect(r).toEqual({ agentType: "claude", source: "character:default" });
  });

  it("allows an explicit ask that is inside the allow-list", () => {
    const runtime = fakeRuntime({
      routing: { coding: { default: "claude", allow: ["claude", "codex"] } },
    });
    const r = resolveCodingBackend({ runtime, explicit: "codex" });
    expect(r).toEqual({ agentType: "codex", source: "explicit" });
  });

  it("constrains the pin to the allow-list too", () => {
    const runtime = fakeRuntime({
      routing: { coding: { allow: ["claude"] } },
      settings: { ELIZA_ACP_DEFAULT_AGENT: "opencode" },
    });
    // pin=opencode is disallowed; planner guess claude is allowed.
    const r = resolveCodingBackend({ runtime, plannerGuess: "claude" });
    expect(r).toEqual({ agentType: "claude", source: "planner" });
  });

  it("returns undefined when nothing satisfies the allow-list", () => {
    const runtime = fakeRuntime({
      routing: { coding: { allow: ["elizaos"] } },
      settings: { ELIZA_ACP_DEFAULT_AGENT: "opencode" },
    });
    expect(
      resolveCodingBackend({
        runtime,
        explicit: "codex",
        plannerGuess: "claude",
      }),
    ).toBeUndefined();
  });

  it("fails closed when the configured allow-list normalizes to no known backends", () => {
    const runtime = fakeRuntime({
      routing: { coding: { allow: ["gpt-9000", ""] } },
      settings: { ELIZA_ACP_DEFAULT_AGENT: "opencode" },
    });
    expect(
      resolveCodingBackend({
        runtime,
        explicit: "codex",
        plannerGuess: "claude",
      }),
    ).toBeUndefined();
  });
});
