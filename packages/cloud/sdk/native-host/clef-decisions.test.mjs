import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import {
  CLEF_DECISION_LIMITS,
  clefDecisionRequestProblem,
  combineActionMode,
  createClefDecisionsClient,
  turnLooksComplete,
} from "./clef-decisions.mjs";

/** @import { ClefDecisionsClientOptions } from "./clef-decisions.mjs" */

const providerError = { status: "unavailable", reason: "provider_error" };
const mode = /** @type {const} */ ({
  kind: "mode",
  action: "Click Pay $84.20",
});

/**
 * A client whose fetch hands each request's signal to `reply`.
 * @param {(signal: AbortSignal) => Response | Promise<Response>} reply
 * @param {Partial<ClefDecisionsClientOptions>} [options]
 */
function client(reply, options = {}) {
  /** @type {Array<number | null>} */
  const statuses = [];
  /** @type {Request[]} */
  const sent = [];
  const decide = createClefDecisionsClient({
    baseUrl: "https://cloud.example",
    headers: () => ({ authorization: "Bearer test" }),
    onUnavailable: (status) => statuses.push(status),
    fetch: async (input, init) => {
      sent.push(new Request(input, init));
      return reply(/** @type {AbortSignal} */ (init?.signal));
    },
    ...options,
  });
  return { decide, statuses, sent };
}

/**
 * Settles only when the signal aborts, like fetch on a silent server.
 * @param {AbortSignal} signal
 */
const hang = (signal) =>
  new Promise((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason));
  });

/**
 * A 200 whose body never finishes and errors when the signal aborts.
 * @param {AbortSignal} signal
 */
const hangingBody = (signal) =>
  new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"status":'));
        signal.addEventListener("abort", () => controller.error(signal.reason));
      },
    }),
    { headers: { "content-type": "application/json" } },
  );

test("a mode suggestion can raise the floor to ask but never lower it", () => {
  assert.equal(combineActionMode("ask", "tell"), "ask");
  assert.equal(combineActionMode("ask", null), "ask");
  assert.equal(combineActionMode("tell", "ask"), "ask");
  assert.equal(combineActionMode("tell", "tell"), "tell");
  assert.equal(combineActionMode("tell", undefined), "tell");
});

test("the offline turn check waits for trailing words and unfinished numbers", () => {
  for (const done of [
    "Pay my electric bill",
    "What's the weather today?",
    "I paid 50.",
  ])
    assert.equal(turnLooksComplete(done), true, done);
  for (const open of [
    "Pay my electric bill and",
    "Call my daughter, um",
    "so",
    "Send $",
    "Pay 1,",
    "The amount is 84 point",
    "I want to...",
    "   ",
  ])
    assert.equal(turnLooksComplete(open), false, open);
});

test("requests over a limit are rejected, never truncated", () => {
  const candidates = [{ id: "n1", label: "Pay now" }];
  assert.equal(
    clefDecisionRequestProblem({ kind: "choice", goal: "pay", candidates }),
    null,
  );
  assert.equal(
    clefDecisionRequestProblem({
      kind: "choice",
      goal: "x".repeat(CLEF_DECISION_LIMITS.goal + 1),
      candidates,
    }),
    "goal",
  );
  for (const bad of [
    [{ id: "none", label: "Reserved" }],
    [
      { id: "a", label: "One" },
      { id: "a", label: "Two" },
    ],
    [],
  ])
    assert.equal(
      clefDecisionRequestProblem({
        kind: "choice",
        goal: "pay",
        candidates: bad,
      }),
      "candidates",
    );
  assert.equal(clefDecisionRequestProblem(mode), null);
  assert.equal(
    clefDecisionRequestProblem({ kind: "mode", action: " " }),
    "action",
  );
  assert.equal(
    clefDecisionRequestProblem({
      kind: "turn",
      transcript: "pay my",
      recentTurns: Array.from({ length: 7 }, () => ({
        speaker: /** @type {const} */ ("person"),
        text: "hi",
      })),
    }),
    "recentTurns",
  );
  assert.equal(
    clefDecisionRequestProblem(/** @type {never} */ ({ kind: "other" })),
    "kind",
  );
});

test("the client turns Cloud failures into unavailable and refuses bad requests", async () => {
  /** @type {Array<() => Response>} */
  const replies = [];
  const { decide, statuses, sent } = client(() => {
    const reply = replies.shift();
    if (!reply) throw new TypeError("offline");
    return reply();
  });
  const turn = /** @type {const} */ ({
    kind: "turn",
    transcript: "pay my bill",
  });
  replies.push(() =>
    Response.json({
      status: "ok",
      kind: "turn",
      model: "clef-flash",
      complete: true,
      completeProbability: 0.93,
    }),
  );
  assert.equal((await decide(turn)).status, "ok");
  assert.equal(sent[0]?.url, "https://cloud.example/api/v1/decisions");
  assert.equal(sent[0]?.headers.get("authorization"), "Bearer test");
  replies.push(() =>
    Response.json(
      { status: "unavailable", reason: "disabled" },
      { status: 503 },
    ),
  );
  assert.deepEqual(await decide(turn), {
    status: "unavailable",
    reason: "disabled",
  });
  assert.deepEqual(await decide(turn), providerError);
  replies.push(() => Response.json({ status: "ok", kind: "mode", model: "x" }));
  assert.deepEqual(await decide(turn), providerError);
  replies.push(() => new Response("<html>Bad gateway</html>", { status: 502 }));
  assert.deepEqual(await decide(turn), providerError);
  assert.deepEqual(statuses, [503, null, 200, 502]);
  replies.push(() => Response.json({ error: "Unauthorized" }, { status: 401 }));
  await assert.rejects(decide(turn), /refused \(401\)/);
  await assert.rejects(decide({ kind: "turn", transcript: "" }), /transcript/);
});

test("the client ends a late request as unavailable with no status", async () => {
  /** @type {(signal: AbortSignal) => Response | Promise<Response>} */
  let reply = hang;
  const { decide, statuses } = client((signal) => reply(signal), {
    timeoutMs: 20,
  });
  assert.deepEqual(await decide(mode), providerError);
  reply = hangingBody;
  assert.deepEqual(await decide(mode), providerError);
  reply = () =>
    Response.json({
      status: "ok",
      kind: "mode",
      model: "clef-flash",
      suggestedMode: "ask",
      askProbability: 0.8,
    });
  assert.equal((await decide(mode)).status, "ok");
  assert.deepEqual(statuses, [null, null]);
});

test("a caller abort rejects, before or after the headers, and reports nothing", async () => {
  for (const reply of [hang, hangingBody]) {
    for (const timeoutMs of [undefined, 60_000]) {
      const { decide, statuses } = client(reply, { timeoutMs });
      const caller = new AbortController();
      const pending = decide(mode, caller.signal);
      setTimeout(() => caller.abort(new Error("stopped")), 10);
      await assert.rejects(pending, /stopped/);
      assert.deepEqual(statuses, []);
    }
  }
});

test("over Node fetch, the deadline bounds the headers and a stalled body", async () => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    response.writeHead(200, { "content-type": "application/json" });
    response.write('{"status":');
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = /** @type {import("node:net").AddressInfo} */ (
    server.address()
  );
  const baseUrl = `http://127.0.0.1:${address.port}`;
  /** @type {Array<number | null>} */
  const statuses = [];
  const onUnavailable = (/** @type {number | null} */ status) =>
    statuses.push(status);
  try {
    /** @type {(headers: Record<string, string>) => void} */
    let releaseHeaders = () => {};
    /** @type {Promise<Record<string, string>>} */
    const lateHeaders = new Promise((resolve) => {
      releaseHeaders = resolve;
    });
    const delayed = createClefDecisionsClient({
      baseUrl,
      headers: () => lateHeaders,
      timeoutMs: 20,
      onUnavailable,
    });
    assert.deepEqual(await delayed(mode), providerError);
    releaseHeaders({});
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(requests, 0, "late headers never dispatch");

    const stalled = createClefDecisionsClient({
      baseUrl,
      headers: () => ({}),
      timeoutMs: 100,
      onUnavailable,
    });
    assert.deepEqual(await stalled(mode), providerError);
    assert.equal(requests, 1);

    const cancellable = createClefDecisionsClient({
      baseUrl,
      headers: () => ({}),
      timeoutMs: 1_000,
      onUnavailable,
    });
    const caller = new AbortController();
    const pending = cancellable(mode, caller.signal);
    setTimeout(() => caller.abort(new Error("stopped")), 100);
    await assert.rejects(pending, /stopped/);
    assert.equal(requests, 2);
    assert.deepEqual(statuses, [null, null]);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
