/**
 * W4: structured-output / prefill / prewarm wiring on the DFlash llama-server
 * backend. Exercises an in-process HTTP mock of llama-server (the same shape
 * the __stress__ suite uses) extended to assert the grammar / prefill /
 * cache_prompt-prewarm semantics on the request body.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildChatCompletionBody,
  type DflashGenerateArgs,
  dflashLlamaServer,
} from "./dflash-server";

interface CapturedRequest {
  url: string;
  body: Record<string, unknown>;
}

function makeArgs(extra: Partial<DflashGenerateArgs> = {}): DflashGenerateArgs {
  return { prompt: "say hello", ...extra };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function readFetchBody(init: RequestInit | undefined): string {
  const body = init?.body;
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  return "";
}

async function startMock(): Promise<{
  baseUrl: string;
  captured: CapturedRequest[];
  close: () => Promise<void>;
}> {
  const captured: CapturedRequest[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const rawUrl =
        typeof input === "string" || input instanceof URL ? input : input.url;
      const url = new URL(rawUrl);
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "GET" && url.pathname === "/metrics") {
        return new Response(
          [
            "llamacpp:prompt_tokens_total 0",
            "llamacpp:n_tokens_predicted_total 0",
            "llamacpp:n_drafted_total 2",
            "llamacpp:n_accepted_total 2",
          ].join("\n"),
          { status: 200 },
        );
      }
      if (method === "POST" && url.pathname === "/v1/chat/completions") {
        const body = JSON.parse(readFetchBody(init)) as Record<string, unknown>;
        captured.push({ url: url.pathname, body });
        return Response.json({
          choices: [{ message: { content: "Hello" } }],
          usage: { prompt_tokens: 3, completion_tokens: 1 },
        });
      }
      return new Response(null, { status: 404 });
    }),
  );
  return {
    baseUrl: "http://dflash-structured.test",
    captured,
    close: async () => {
      vi.unstubAllGlobals();
    },
  };
}

describe("buildChatCompletionBody", () => {
  it("folds a grammar string into the request body", () => {
    const body = buildChatCompletionBody(
      makeArgs({ grammar: 'root ::= "hi"' }),
      0,
      false,
    );
    expect(body.grammar).toBe('root ::= "hi"');
    expect(body.grammar_lazy).toBeUndefined();
    expect(body.cache_prompt).toBe(true);
    expect(body.slot_id).toBe(0);
  });

  it("compiles a responseSkeleton to a lazy grammar with triggers", () => {
    const body = buildChatCompletionBody(
      makeArgs({
        responseSkeleton: {
          spans: [
            { kind: "literal", value: '{"r":"' },
            { kind: "enum", key: "r", enumValues: ["A", "B"] },
            { kind: "literal", value: '","t":"' },
            { kind: "free-string", key: "t" },
            { kind: "literal", value: '"}' },
          ],
        },
      }),
      2,
      true,
    );
    expect(typeof body.grammar).toBe("string");
    expect(body.grammar_lazy).toBe(true);
    expect(body.grammar_triggers).toEqual([{ type: "word", value: '{"r":"' }]);
    expect(body.stream).toBe(true);
    expect(body.slot_id).toBe(2);
  });

  it("appends a trailing assistant message + continue_final_message for prefill", () => {
    const body = buildChatCompletionBody(
      makeArgs({ prefill: '{"shouldRespond":"' }),
      1,
      false,
    );
    expect(body.messages).toEqual([
      { role: "user", content: "say hello" },
      { role: "assistant", content: '{"shouldRespond":"' },
    ]);
    expect(body.continue_final_message).toBe(true);
    expect(body.add_generation_prompt).toBe(false);
  });

  it("omits prefill plumbing when there is no prefill", () => {
    const body = buildChatCompletionBody(makeArgs(), 0, false);
    expect(body.messages).toEqual([{ role: "user", content: "say hello" }]);
    expect(body.continue_final_message).toBeUndefined();
  });
});

describe("DflashLlamaServer.prewarmConversation", () => {
  let saved: { baseUrl: string | null; cacheParallel: number };
  afterEach(() => {
    const target = dflashLlamaServer as unknown as {
      baseUrl: string | null;
      cacheParallel: number;
    };
    target.baseUrl = saved.baseUrl;
    target.cacheParallel = saved.cacheParallel;
  });

  it("fires a max_tokens:1 cache_prompt request against the pinned slot", async () => {
    const mock = await startMock();
    const target = dflashLlamaServer as unknown as {
      baseUrl: string | null;
      cacheParallel: number;
    };
    saved = { baseUrl: target.baseUrl, cacheParallel: target.cacheParallel };
    target.baseUrl = mock.baseUrl;
    target.cacheParallel = 4;
    try {
      const ok = await dflashLlamaServer.prewarmConversation(
        "system prompt prefix",
        {
          slotId: 3,
        },
      );
      expect(ok).toBe(true);
      expect(mock.captured.length).toBe(1);
      const body = mock.captured[0].body;
      expect(body.max_tokens).toBe(1);
      expect(body.cache_prompt).toBe(true);
      expect(body.slot_id).toBe(3);
      expect(body.messages).toEqual([
        { role: "user", content: "system prompt prefix" },
      ]);
    } finally {
      await mock.close();
    }
  });

  it("returns false when no server is running", async () => {
    const target = dflashLlamaServer as unknown as {
      baseUrl: string | null;
      cacheParallel: number;
    };
    saved = { baseUrl: target.baseUrl, cacheParallel: target.cacheParallel };
    target.baseUrl = null;
    expect(await dflashLlamaServer.prewarmConversation("x", {})).toBe(false);
    expect(await dflashLlamaServer.prewarmConversation("", { slotId: 0 })).toBe(
      false,
    );
  });
});

describe("DflashLlamaServer generate with grammar + prefill (non-streaming)", () => {
  it("includes the grammar + prefill in the request and re-prepends the prefill", async () => {
    const mock = await startMock();
    const target = dflashLlamaServer as unknown as {
      baseUrl: string | null;
      cacheParallel: number;
    };
    const saved = {
      baseUrl: target.baseUrl,
      cacheParallel: target.cacheParallel,
    };
    target.baseUrl = mock.baseUrl;
    target.cacheParallel = 4;
    try {
      const result = await dflashLlamaServer.generateWithUsage(
        makeArgs({ grammar: 'root ::= "x"', prefill: "pre:" }),
      );
      expect(result.text).toBe("pre:Hello");
      const body = mock.captured[0].body;
      expect(body.grammar).toBe('root ::= "x"');
      expect(body.continue_final_message).toBe(true);
    } finally {
      target.baseUrl = saved.baseUrl;
      target.cacheParallel = saved.cacheParallel;
      await mock.close();
    }
  });
});
