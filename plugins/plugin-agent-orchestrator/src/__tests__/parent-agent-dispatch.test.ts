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
});
