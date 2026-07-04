/**
 * Verifies extractParentAgentDirective.
 * Deterministic unit test of pure helpers; no runtime, no live model.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  dispatchParentAgentDirective,
  extractParentAgentDirective,
  PARENT_AGENT_DIRECTIVE_MARKER,
  parentAgentMarkerIndex,
} from "../services/parent-agent-dispatch.js";
import { resetSessionSpendUsd } from "../services/spend-allowance.js";

function createRuntime(overrides: Partial<IAgentRuntime> = {}): IAgentRuntime {
  const cache = new Map<string, unknown>();
  return {
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
    getCache: async (key: string) => cache.get(key),
    setCache: async (key: string, value: unknown) => {
      cache.set(key, value);
    },
    deleteCache: async (key: string) => {
      cache.delete(key);
    },
    ...overrides,
  } as IAgentRuntime;
}

describe("extractParentAgentDirective", () => {
  it("uses the canonical marker", () => {
    expect(PARENT_AGENT_DIRECTIVE_MARKER).toBe("USE_SKILL parent-agent");
  });

  it("returns null when no marker is present", () => {
    expect(extractParentAgentDirective("just some agent output")).toBeNull();
    expect(parentAgentMarkerIndex("nope")).toBe(-1);
  });

  it("parses a complete directive embedded in surrounding text", () => {
    const text =
      'Let me check the cloud.\nUSE_SKILL parent-agent {"mode":"list-cloud-commands"}\nDone.';
    const d = extractParentAgentDirective(text);
    expect(d).not.toBeNull();
    expect(d?.args).toEqual({ mode: "list-cloud-commands" });
    // endIndex points just past the closing brace.
    expect(text.slice(d?.endIndex)).toBe("\nDone.");
  });

  it("tolerates a markdown backtick before the JSON", () => {
    const d = extractParentAgentDirective(
      'USE_SKILL parent-agent `{"mode":"list-actions","query":"github"}`',
    );
    expect(d?.args).toEqual({ mode: "list-actions", query: "github" });
  });

  it("returns null while the JSON is still streaming (unbalanced)", () => {
    expect(
      extractParentAgentDirective('USE_SKILL parent-agent {"mode":"cloud-comm'),
    ).toBeNull();
    expect(
      extractParentAgentDirective(
        'USE_SKILL parent-agent {"command":"domains.buy","params":{',
      ),
    ).toBeNull();
  });

  it("does not end the object early on braces inside string values", () => {
    const d = extractParentAgentDirective(
      'USE_SKILL parent-agent {"request":"use the {weird} value","mode":"ask"}',
    );
    expect(d?.args).toEqual({ request: "use the {weird} value", mode: "ask" });
  });

  it("handles nested params objects", () => {
    const d = extractParentAgentDirective(
      'USE_SKILL parent-agent {"mode":"cloud-command","command":"domains.buy","params":{"domain":"x.com","spendEstimateUsd":14.95}}',
    );
    expect(d?.args).toEqual({
      mode: "cloud-command",
      command: "domains.buy",
      params: { domain: "x.com", spendEstimateUsd: 14.95 },
    });
  });

  it("returns null for balanced-but-malformed JSON (dead marker)", () => {
    expect(
      extractParentAgentDirective("USE_SKILL parent-agent {not json}"),
    ).toBeNull();
  });

  it("returns null when the marker is followed by non-JSON prose", () => {
    expect(
      extractParentAgentDirective("USE_SKILL parent-agent please do the thing"),
    ).toBeNull();
  });
});

describe("dispatchParentAgentDirective", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    resetSessionSpendUsd();
  });

  it("runs the directive through the broker and streams the reply to the session", async () => {
    const sent: Array<{ sessionId: string; input: string }> = [];
    const acp = {
      sendToSession: async (sessionId: string, input: string) => {
        sent.push({ sessionId, input });
        return { ok: true } as unknown as ReturnType<
          import("../services/acp-service.js").AcpService["sendToSession"]
        >;
      },
    };

    // list-cloud-commands needs no network/cloud key — it renders the static
    // command catalog — so this exercises the full broker→sendToSession bridge.
    const result = await dispatchParentAgentDirective({
      runtime: createRuntime(),
      acp,
      sessionId: "sess-1",
      args: { mode: "list-cloud-commands" },
    });

    expect(result.ok).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].sessionId).toBe("sess-1");
    // The reply is the broker's command catalog text.
    expect(sent[0].input.toLowerCase()).toContain("domains.buy");
    expect(result.reply).toBe(sent[0].input);
  });

  it("reports a delivery failure without throwing", async () => {
    const acp = {
      sendToSession: async () => {
        throw new Error("session gone");
      },
    };
    const result = await dispatchParentAgentDirective({
      runtime: createRuntime(),
      acp,
      sessionId: "sess-2",
      args: { mode: "list-cloud-commands" },
    });
    expect(result.ok).toBe(false);
  });

  // Regression: a child streams its directive mid-turn and then ends the turn to
  // await the reply. Delivering the reply is a new prompt, which the transport
  // rejects with "session is already busy" until the turn finishes — so the
  // dispatcher must retry until the session goes idle instead of dropping it
  // (a dropped reply stalls the loop on its first directive).
  it("retries delivery while the child turn is still in flight (session busy)", async () => {
    let attempts = 0;
    const acp = {
      sendToSession: async (sessionId: string) => {
        attempts++;
        if (attempts < 3) {
          throw new Error(`ACP session is already busy: ${sessionId}`);
        }
        return {} as unknown as ReturnType<
          import("../services/acp-service.js").AcpService["sendToSession"]
        >;
      },
    };
    const result = await dispatchParentAgentDirective({
      runtime: createRuntime(),
      acp,
      sessionId: "sess-3",
      args: { mode: "list-cloud-commands" },
    });
    expect(attempts).toBe(3);
    expect(result.ok).toBe(true);
  }, 10_000);

  it("stops retrying and reports failure once the busy deadline passes", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const acp = {
        sendToSession: async (sessionId: string) => {
          calls++;
          throw new Error(`ACP session is already busy: ${sessionId}`);
        },
      };
      const p = dispatchParentAgentDirective({
        runtime: createRuntime(),
        acp,
        sessionId: "sess-4",
        args: { mode: "list-cloud-commands" },
      });
      // Drive the fake clock past the delivery deadline; the loop must give up.
      await vi.advanceTimersByTimeAsync(300_001);
      const result = await p;
      expect(result.ok).toBe(false);
      expect(calls).toBeGreaterThan(1); // it retried — did not bail after one attempt
    } finally {
      vi.useRealTimers();
    }
  }, 20_000);

  it("does not retry a terminal (non-busy) delivery error", async () => {
    let calls = 0;
    const acp = {
      sendToSession: async () => {
        calls++;
        throw new Error("session lost");
      },
    };
    const result = await dispatchParentAgentDirective({
      runtime: createRuntime(),
      acp,
      sessionId: "sess-5",
      args: { mode: "list-cloud-commands" },
    });
    expect(result.ok).toBe(false);
    expect(calls).toBe(1);
  });
});
