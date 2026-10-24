import { expect, test } from "bun:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  CLEF_DECISION_LIMITS,
  clefDecisionRequestProblem,
  combineActionMode,
  createClefDecisionsClient,
  turnLooksComplete,
} from "./clef-decisions.js";

test("a mode suggestion can raise the floor to ask but never lower it", () => {
  expect(combineActionMode("ask", "tell")).toBe("ask");
  expect(combineActionMode("ask", null)).toBe("ask");
  expect(combineActionMode("tell", "ask")).toBe("ask");
  expect(combineActionMode("tell", "tell")).toBe("tell");
  expect(combineActionMode("tell", undefined)).toBe("tell");
});

test("the offline turn check waits for trailing words and unfinished numbers", () => {
  expect(turnLooksComplete("Pay my electric bill")).toBe(true);
  expect(turnLooksComplete("What's the weather today?")).toBe(true);
  expect(turnLooksComplete("I paid 50.")).toBe(true);
  expect(turnLooksComplete("Pay my electric bill and")).toBe(false);
  expect(turnLooksComplete("Call my daughter, um")).toBe(false);
  expect(turnLooksComplete("so")).toBe(false);
  expect(turnLooksComplete("Send $")).toBe(false);
  expect(turnLooksComplete("Pay 1,")).toBe(false);
  expect(turnLooksComplete("The amount is 84 point")).toBe(false);
  expect(turnLooksComplete("I want to...")).toBe(false);
  expect(turnLooksComplete("   ")).toBe(false);
});

test("requests over a limit are rejected, never truncated", () => {
  const candidates = [{ id: "n1", label: "Pay now" }];
  expect(
    clefDecisionRequestProblem({ kind: "choice", goal: "pay", candidates }),
  ).toBeNull();
  expect(
    clefDecisionRequestProblem({
      kind: "choice",
      goal: "x".repeat(CLEF_DECISION_LIMITS.goal + 1),
      candidates,
    }),
  ).toBe("goal");
  expect(
    clefDecisionRequestProblem({
      kind: "choice",
      goal: "pay",
      candidates: [{ id: "none", label: "Reserved" }],
    }),
  ).toBe("candidates");
  expect(
    clefDecisionRequestProblem({
      kind: "choice",
      goal: "pay",
      candidates: [
        { id: "a", label: "One" },
        { id: "a", label: "Two" },
      ],
    }),
  ).toBe("candidates");
  expect(
    clefDecisionRequestProblem({ kind: "choice", goal: "pay", candidates: [] }),
  ).toBe("candidates");
  expect(
    clefDecisionRequestProblem({ kind: "mode", action: "Click Pay $84.20" }),
  ).toBeNull();
  expect(clefDecisionRequestProblem({ kind: "mode", action: " " })).toBe(
    "action",
  );
  expect(
    clefDecisionRequestProblem({
      kind: "turn",
      transcript: "pay my",
      recentTurns: Array.from({ length: 7 }, () => ({
        speaker: "person" as const,
        text: "hi",
      })),
    }),
  ).toBe("recentTurns");
  expect(clefDecisionRequestProblem({ kind: "other" } as never)).toBe("kind");
});

test("the client turns Cloud failures into unavailable and refuses bad requests", async () => {
  const replies: Array<() => Response | Promise<Response>> = [];
  const sent: Request[] = [];
  const decide = createClefDecisionsClient({
    baseUrl: "https://cloud.example",
    headers: () => ({ authorization: "Bearer test" }),
    fetch: (async (input: URL, init: RequestInit) => {
      sent.push(new Request(input, init));
      const reply = replies.shift();
      if (!reply) throw new TypeError("offline");
      return reply();
    }) as typeof fetch,
  });
  const turn = { kind: "turn" as const, transcript: "pay my bill" };
  replies.push(() =>
    Response.json({
      status: "ok",
      kind: "turn",
      model: "clef-flash",
      complete: true,
      completeProbability: 0.93,
    }),
  );
  expect(await decide(turn)).toMatchObject({ status: "ok", complete: true });
  expect(sent[0]?.url).toBe("https://cloud.example/api/v1/decisions");
  expect(sent[0]?.headers.get("authorization")).toBe("Bearer test");
  replies.push(() =>
    Response.json(
      { status: "unavailable", reason: "disabled" },
      { status: 503 },
    ),
  );
  expect(await decide(turn)).toEqual({
    status: "unavailable",
    reason: "disabled",
  });
  expect(await decide(turn)).toEqual({
    status: "unavailable",
    reason: "provider_error",
  });
  replies.push(() => Response.json({ status: "ok", kind: "mode", model: "x" }));
  expect(await decide(turn)).toEqual({
    status: "unavailable",
    reason: "provider_error",
  });
  replies.push(() => Response.json({ error: "Unauthorized" }, { status: 401 }));
  await expect(decide(turn)).rejects.toThrow("refused (401)");
  await expect(decide({ kind: "turn", transcript: "" })).rejects.toThrow(
    "transcript",
  );
});

test("the client ends a late request as unavailable and reports each one", async () => {
  const statuses: Array<number | null> = [];
  let reply: (signal: AbortSignal) => Promise<Response>;
  const decide = createClefDecisionsClient({
    baseUrl: "https://cloud.example",
    headers: () => ({}),
    timeoutMs: 20,
    onUnavailable: (status) => statuses.push(status),
    fetch: (async (_input: URL, init: RequestInit) =>
      reply(init.signal as AbortSignal)) as typeof fetch,
  });
  const mode = { kind: "mode" as const, action: "Click Pay $84.20" };
  // Like fetch: settles only when its signal aborts.
  const hang = (signal: AbortSignal) =>
    new Promise<Response>((_resolve, reject) => {
      if (signal.aborted) reject(signal.reason);
      signal.addEventListener("abort", () => reject(signal.reason));
    });
  reply = hang;
  expect(await decide(mode)).toEqual({
    status: "unavailable",
    reason: "provider_error",
  });
  reply = async () =>
    Response.json(
      { status: "unavailable", reason: "disabled" },
      { status: 503 },
    );
  expect(await decide(mode)).toEqual({
    status: "unavailable",
    reason: "disabled",
  });
  reply = async () =>
    Response.json({
      status: "ok",
      kind: "mode",
      model: "clef-flash",
      suggestedMode: "ask",
      askProbability: 0.8,
    });
  expect(await decide(mode)).toMatchObject({ suggestedMode: "ask" });
  expect(statuses).toEqual([null, 503]);
  const caller = new AbortController();
  reply = hang;
  const pending = decide(mode, caller.signal);
  caller.abort(new Error("stopped"));
  await expect(pending).rejects.toThrow("stopped");
});

test("deadline bounds headers and streamed bodies without swallowing caller cancellation", async () => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    response.writeHead(200, { "content-type": "application/json" });
    response.write('{"status":');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const statuses: Array<number | null> = [];
  const onUnavailable = (status: number | null) => statuses.push(status);
  const request = { kind: "mode" as const, action: "Read the page" };
  try {
    let releaseHeaders!: (headers: Record<string, string>) => void;
    const headers = new Promise<Record<string, string>>((resolve) => {
      releaseHeaders = resolve;
    });
    const delayed = createClefDecisionsClient({
      baseUrl,
      headers: () => headers,
      timeoutMs: 20,
      onUnavailable,
    });
    expect(await delayed(request)).toEqual({
      status: "unavailable",
      reason: "provider_error",
    });
    releaseHeaders({});
    await new Promise((resolve) => setImmediate(resolve));
    expect(requests).toBe(0);
    expect(statuses).toEqual([null]);

    const stalled = createClefDecisionsClient({
      baseUrl,
      headers: () => ({}),
      timeoutMs: 100,
      onUnavailable,
    });
    expect(await stalled(request)).toEqual({
      status: "unavailable",
      reason: "provider_error",
    });
    expect(statuses).toEqual([null, 200]);

    let bodyReading!: () => void;
    const reading = new Promise<void>((resolve) => {
      bodyReading = resolve;
    });
    const cancellable = createClefDecisionsClient({
      baseUrl,
      headers: () => ({}),
      timeoutMs: 1000,
      onUnavailable,
      fetch: (async (input, init) => {
        const response = await fetch(input, init);
        const json = response.json.bind(response);
        response.json = () => {
          bodyReading();
          return json();
        };
        return response;
      }) as typeof fetch,
    });
    const caller = new AbortController();
    const pending = cancellable(request, caller.signal);
    const outcome = pending.then(
      (value) => value,
      (error: unknown) => error,
    );
    await reading;
    const stopped = new Error("caller stopped body read");
    caller.abort(stopped);
    expect(await outcome).toBe(stopped);
    expect(statuses).toEqual([null, 200]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
