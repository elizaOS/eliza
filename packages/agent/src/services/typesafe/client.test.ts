/**
 * Exercises the actual TypeSafe adapter against synthetic HTTP responses.
 * These deterministic contract tests make no provider calls and do not establish
 * model accuracy, account access, latency, billing, or runtime integration.
 */
import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TypeSafeDecisionClient,
  type TypeSafeDecisionRequest,
  type TypeSafeDecisionResponse,
} from "./client";

const request: TypeSafeDecisionRequest = {
  state: {
    text: "Synthetic ticket: billing question. Exact punctuation: 🍊.,",
    history: ["first", "second"],
  },
  model: "jev-latest",
  questions: {
    department: {
      type: "choice",
      instructions: "Choose a department.",
      criteria: { billing: "Payment", technical: null },
    },
    severity: {
      type: "score",
      instructions: { rubric: "Rate severity." },
      criteria: ["Low", "High"],
    },
    urgent: {
      type: "noul",
      instructions: ["Is this urgent?"],
      criteria: { true: "Time-sensitive", false: "Routine" },
    },
  },
};

function response(): TypeSafeDecisionResponse {
  return {
    model: "jev-1.13.0",
    answers: {
      department: {
        type: "choice",
        choice: "billing",
        confidence: 0.8,
        probabilities: { billing: 0.9, technical: 0.1 },
      },
      severity: {
        type: "score",
        score: 0.2,
        confidence: 0.6,
        legend: { "0": "Low", "1": "High" },
        probabilities: { "0": 0.8, "1": 0.2 },
      },
      urgent: { type: "noul", noul: 0.1 },
    },
    usage: { input_tokens: 120, output_tokens: 20 },
  };
}

function client(
  fetch: (input: string, init: RequestInit) => Promise<Response>,
  timeoutMs = 10_000,
) {
  return new TypeSafeDecisionClient({
    apiKey: "synthetic-key",
    fetch,
    timeoutMs,
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("TypeSafeDecisionClient documented HTTP contract", () => {
  it("retains own special dictionary keys and complete nested JSON values", async () => {
    const payload: TypeSafeDecisionRequest = JSON.parse(
      '{"model":"jev-latest","state":{"__proto__":{"label":"complete"},"constructor":"preserved"},"questions":{"__proto__":{"type":"choice","instructions":"Choose.","criteria":{"__proto__":null,"constructor":"Alternative"}}}}',
    );
    const result = JSON.parse(
      '{"model":"jev-latest","answers":{"__proto__":{"type":"choice","choice":"__proto__","confidence":1,"probabilities":{"__proto__":1,"constructor":0}}},"usage":{"input_tokens":1,"output_tokens":1}}',
    );
    const adapter = client(async (_url, init) => {
      expect(JSON.parse(String(init.body))).toEqual(payload);
      return Response.json(result);
    });
    expect(await adapter.systemOne(payload)).toEqual(result);
  });

  it("validates against the dispatched snapshot if the caller later changes the request", async () => {
    const payload = structuredClone(request);
    const adapter = client(async () => {
      payload.questions.department = {
        type: "noul",
        instructions: "Changed later",
      };
      return Response.json(response());
    });
    expect(await adapter.systemOne(payload)).toEqual(response());
  });

  it("posts complete state and all three questions, preserving typed answers and usage", async () => {
    let calls = 0;
    const original = structuredClone(request);
    const adapter = client(async (url, init) => {
      calls += 1;
      expect(url).toBe("https://api.typesafe.ai/v1/systemone");
      expect(init.method).toBe("POST");
      expect(init.redirect).toBe("error");
      expect(init.credentials).toBe("omit");
      expect(init.headers).toEqual({
        Authorization: "Bearer synthetic-key",
        "Content-Type": "application/json",
      });
      expect(JSON.parse(String(init.body))).toEqual(original);
      expect(init.signal).toBeInstanceOf(AbortSignal);
      return Response.json(response());
    });
    expect(await adapter.systemOne(request)).toEqual(response());
    expect(request).toEqual(original);
    expect(calls).toBe(1);
  });

  it("accepts string and array state, optional Noul criteria, and a configured HTTPS endpoint", async () => {
    const adapter = new TypeSafeDecisionClient({
      apiKey: "synthetic-key",
      endpoint: "https://example.invalid/custom/systemone",
      fetch: async (url, init) => {
        expect(url).toBe("https://example.invalid/custom/systemone");
        const wire = JSON.parse(String(init.body));
        expect(wire.questions.flag).toEqual({
          type: "noul",
          instructions: "Is this routine?",
        });
        return Response.json({
          model: "jev-latest",
          answers: { flag: { type: "noul", noul: 1 } },
          usage: { input_tokens: 0, output_tokens: 0 },
        });
      },
    });
    for (const state of ["complete string", ["first", { item: 2 }]]) {
      await expect(
        adapter.systemOne({
          state,
          model: "jev-latest",
          questions: {
            flag: { type: "noul", instructions: "Is this routine?" },
          },
        }),
      ).resolves.toMatchObject({ answers: { flag: { noul: 1 } } });
    }
  });

  it.each([401, 422, 429, 529, 503, 302])(
    "reports HTTP %i without response text or retries",
    async (status) => {
      let calls = 0;
      const adapter = client(async () => {
        calls += 1;
        return new Response("secret-state synthetic-key", { status });
      });
      await expect(adapter.systemOne(request)).rejects.toMatchObject({
        code: "TYPESAFE_HTTP",
        context: { status },
      });
      expect(calls).toBe(1);
    },
  );

  it("does not expose request state, credentials, URLs, or transport causes in errors", async () => {
    const adapter = client(async () => {
      throw new Error("synthetic-key secret-state");
    });
    try {
      await adapter.systemOne(request);
      expect.fail("transport should reject");
    } catch (error) {
      expect(error).toMatchObject({ code: "TYPESAFE_TRANSPORT" });
      expect(inspect(error)).not.toMatch(/synthetic-key|secret-state/);
      expect(error).not.toHaveProperty("cause");
    }
    expect(inspect(adapter)).not.toContain("synthetic-key");
  });

  it("rejects malformed JSON without including the response text", async () => {
    await expect(
      client(async () => new Response("secret-state is not JSON")).systemOne(
        request,
      ),
    ).rejects.toMatchObject({ code: "TYPESAFE_INVALID_RESPONSE" });
  });

  it.each([
    [
      "unknown answer type",
      (value: Record<string, unknown>) => {
        value.answers = { department: { type: "text", text: "invented" } };
      },
    ],
    [
      "missing answer",
      (value: Record<string, unknown>) => {
        delete (value.answers as Record<string, unknown>).urgent;
      },
    ],
    [
      "extra answer",
      (value: Record<string, unknown>) => {
        (value.answers as Record<string, unknown>).extra = {
          type: "noul",
          noul: 0,
        };
      },
    ],
    [
      "mismatched answer type",
      (value: Record<string, unknown>) => {
        (value.answers as Record<string, unknown>).urgent = {
          type: "choice",
          choice: "x",
          probabilities: { x: 1 },
          confidence: 1,
        };
      },
    ],
    [
      "unknown choice",
      (value: Record<string, unknown>) => {
        (value.answers as Record<string, unknown>).department = {
          type: "choice",
          choice: "other",
          probabilities: { billing: 0.9, technical: 0.1 },
          confidence: 1,
        };
      },
    ],
    [
      "missing probability",
      (value: Record<string, unknown>) => {
        (value.answers as Record<string, unknown>).department = {
          type: "choice",
          choice: "billing",
          probabilities: { billing: 1 },
          confidence: 1,
        };
      },
    ],
    [
      "invalid probability",
      (value: Record<string, unknown>) => {
        (value.answers as Record<string, unknown>).urgent = {
          type: "noul",
          noul: 1.1,
        };
      },
    ],
    [
      "invalid distribution",
      (value: Record<string, unknown>) => {
        (value.answers as Record<string, unknown>).department = {
          type: "choice",
          choice: "billing",
          probabilities: { billing: 0.8, technical: 0.1 },
          confidence: 1,
        };
      },
    ],
    [
      "changed score legend",
      (value: Record<string, unknown>) => {
        (value.answers as Record<string, unknown>).severity = {
          type: "score",
          score: 0.2,
          confidence: 1,
          legend: { "0": "Changed", "1": "High" },
          probabilities: { "0": 0.8, "1": 0.2 },
        };
      },
    ],
    [
      "score beyond rubric",
      (value: Record<string, unknown>) => {
        (value.answers as Record<string, unknown>).severity = {
          type: "score",
          score: 2,
          confidence: 1,
          legend: { "0": "Low", "1": "High" },
          probabilities: { "0": 0.8, "1": 0.2 },
        };
      },
    ],
    [
      "invalid usage",
      (value: Record<string, unknown>) => {
        value.usage = { input_tokens: -1, output_tokens: 0 };
      },
    ],
    [
      "unknown top-level contract",
      (value: Record<string, unknown>) => {
        value.choices = [];
      },
    ],
  ])("rejects %s", async (_name, mutate) => {
    const value: Record<string, unknown> = structuredClone(response());
    mutate(value);
    await expect(
      client(async () => Response.json(value)).systemOne(request),
    ).rejects.toMatchObject({ code: "TYPESAFE_INVALID_RESPONSE" });
  });

  it.each([
    { ...request, questions: {} },
    { ...request, model: " " },
    { ...request, state: { value: Number.NaN } },
    { ...request, state: { missing: undefined } },
    {
      ...request,
      questions: {
        score: { type: "score", instructions: "Rate", criteria: ["one"] },
      },
    },
    {
      ...request,
      questions: { bad: { type: "text", instructions: "Invented" } },
    },
  ])("rejects unsupported request values before sending", async (value) => {
    let calls = 0;
    const adapter = client(async () => {
      calls += 1;
      return Response.json(response());
    });
    await expect(
      adapter.systemOne(value as TypeSafeDecisionRequest),
    ).rejects.toMatchObject({ code: "TYPESAFE_INVALID_REQUEST" });
    expect(calls).toBe(0);
  });

  it("rejects cyclic state without leaking its contents", async () => {
    const cyclic: Record<string, unknown> = { private: "secret-state" };
    cyclic.self = cyclic;
    await expect(
      client(async () => Response.json(response())).systemOne({
        ...request,
        state: cyclic,
      } as TypeSafeDecisionRequest),
    ).rejects.toMatchObject({ code: "TYPESAFE_INVALID_REQUEST" });
  });

  it("cancels before dispatch and never exposes a caller's abort reason", async () => {
    const controller = new AbortController();
    controller.abort("secret-state");
    let calls = 0;
    const adapter = client(async () => {
      calls += 1;
      return Response.json(response());
    });
    await expect(
      adapter.systemOne(request, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: "TYPESAFE_CANCELLED" });
    expect(calls).toBe(0);
  });

  it("cancels an in-flight transport even when the transport ignores abort", async () => {
    const controller = new AbortController();
    let sentSignal: AbortSignal | null | undefined;
    const adapter = client(async (_url, init) => {
      sentSignal = init.signal;
      return new Promise<Response>(() => undefined);
    });
    const pending = adapter.systemOne(request, { signal: controller.signal });
    const rejected = expect(pending).rejects.toMatchObject({
      code: "TYPESAFE_CANCELLED",
    });
    controller.abort("secret-state");
    await rejected;
    expect(sentSignal?.aborted).toBe(true);
  });

  it.each(["headers", "body"])(
    "bounds the entire transport including stalled %s",
    async (stage) => {
      vi.useFakeTimers();
      let sentSignal: AbortSignal | null | undefined;
      const adapter = client(async (_url, init) => {
        sentSignal = init.signal;
        if (stage === "headers") return new Promise<Response>(() => undefined);
        return new Response(new ReadableStream());
      }, 25);
      const rejected = expect(adapter.systemOne(request)).rejects.toMatchObject(
        { code: "TYPESAFE_TIMEOUT" },
      );
      await vi.advanceTimersByTimeAsync(25);
      await rejected;
      expect(sentSignal?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("clears the timeout after success", async () => {
    vi.useFakeTimers();
    await client(async () => Response.json(response())).systemOne(request);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 60_001, 0.5])(
    "rejects invalid timeout %s",
    (timeoutMs) => {
      expect(
        () =>
          new TypeSafeDecisionClient({ apiKey: "synthetic-key", timeoutMs }),
      ).toThrow(expect.objectContaining({ code: "TYPESAFE_CONFIG" }));
    },
  );

  it.each([
    "http://example.invalid",
    "https://key:secret@example.invalid",
    "https://example.invalid?key=secret",
    "https://example.invalid#secret",
    "not-a-url",
  ])("rejects unsafe endpoint %s", (endpoint) => {
    expect(
      () => new TypeSafeDecisionClient({ apiKey: "synthetic-key", endpoint }),
    ).toThrow(expect.objectContaining({ code: "TYPESAFE_CONFIG" }));
  });

  it("requires an explicit key and rejects browser use", () => {
    expect(() => new TypeSafeDecisionClient({ apiKey: "" })).toThrow(
      expect.objectContaining({ code: "TYPESAFE_CONFIG" }),
    );
    vi.stubGlobal("window", {});
    expect(
      () => new TypeSafeDecisionClient({ apiKey: "synthetic-key" }),
    ).toThrow(expect.objectContaining({ code: "TYPESAFE_SERVER_ONLY" }));
  });
});
