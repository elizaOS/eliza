/** A host that skips post-turn review (mobile) never gets a retention
 * checkpoint, so every model call carried the room's whole lifetime: a two-day
 * phone conversation of 283 messages sent 24k-34k input tokens per call. */
import { ChannelType, type ContextEvent, type Memory } from "@elizaos/core";
import { afterEach, expect, it, vi } from "vitest";
import {
  makeMessage,
  makeRuntime,
  makeState,
  runStage1,
  stage1Response,
  useModelCalls,
} from "../../__tests__/stage1/fixtures.ts";
import { runEvaluator } from "../../runtime/evaluator.ts";
import {
  applyHistoryRetentionReview,
  HISTORY_WINDOW_KEEP_SOURCES,
  HISTORY_WINDOW_MAX_SOURCES,
  HISTORY_WINDOW_STANDING_SOURCES,
  prepareHistoryRetention,
  visibleHistoryEventIds,
  windowHistoryRetention,
} from "../../runtime/history-retention.ts";
import { runPlannerLoop } from "../../runtime/planner-loop.ts";
import { historyRetentionEvaluator } from "../history-retention.ts";
import { CLIENT_OBSERVATION_SEGMENT_LABEL } from "./client-observation-context.ts";
import { buildCurrentTurnBoundary } from "./context-assembly.ts";
import {
  loadHistoryReferences,
  projectBackgroundHistory,
  projectReviewedHistory,
  recallDeferredHistory,
  requestedHistory,
  withBackgroundHistory,
} from "./history-discovery.ts";
import { renderMessageHandlerModelInput } from "./stage1-input.ts";

const scope = {
  agentId: "agent",
  roomId: "room",
  entityId: "owner",
  roles: ["OWNER"],
};
const alternate = (index: number) => (index % 2 ? "agent" : "user");
const segment = (
  id: string,
  label: string,
  content: string,
  source = "message-service",
): ContextEvent => ({
  id,
  type: "segment",
  source,
  segment: { id, label, content, stable: false },
});

function room(
  count: number,
  extra: ContextEvent[] = [],
  speaker: (index: number) => string = alternate,
  text: (index: number) => string = (index) => `original-${index}.`,
) {
  return {
    id: "turn",
    metadata: { roomId: "room", messageId: "turn" },
    events: [
      ...Array.from(
        { length: count },
        (_, i): ContextEvent => ({
          id: `history:${i}`,
          type: "segment",
          source: "prior-dialogue",
          segment: {
            id: `history:${i}`,
            label: `prior_message:${speaker(i)}`,
            content: text(i),
            stable: false,
            metadata: {
              roomId: "room",
              entityId: speaker(i) === "agent" ? "agent" : "owner",
            },
          },
        }),
      ),
      ...extra,
      {
        id: "current-turn-boundary",
        type: "instruction",
        source: "message-service",
        stable: false,
        content: buildCurrentTurnBoundary({ hasMemoryRecallSurface: false }),
      },
    ],
  };
}

function stage1(...args: Parameters<typeof room>) {
  const context = room(...args);
  const window = windowHistoryRetention(context, scope, null);
  const history = projectReviewedHistory(context, scope, window.checkpoint);
  if (history && window.windowed) history.windowed = true;
  const user = String(
    renderMessageHandlerModelInput(
      { character: { name: "Eliza" } },
      context,
      [],
      { directMessage: true, nativeTools: true, history },
    ).messages[1]?.content,
  );
  return { context, window, history, user };
}

it("keeps a small room complete and defers by position past the limit", () => {
  const small = stage1(HISTORY_WINDOW_MAX_SOURCES);
  expect(small.window).toEqual({ checkpoint: null, windowed: false });
  expect(small.user).toContain("original-0.");
  expect(small.user).not.toContain("runtime:history_not_shown");
  expect(small.user).toContain("do not invent a history search");

  const large = stage1(HISTORY_WINDOW_MAX_SOURCES + 1);
  const boundary = HISTORY_WINDOW_MAX_SOURCES - HISTORY_WINDOW_KEEP_SOURCES;
  expect(large.window.windowed).toBe(true);
  expect(large.window.checkpoint?.reviewedCount).toBe(boundary);
  expect(large.user).not.toContain(`original-${boundary - 1}.`);
  expect(large.user).toContain(`original-${boundary}.`);
  expect(large.user).toContain(`original-${HISTORY_WINDOW_MAX_SOURCES}.`);
  expect(
    visibleHistoryEventIds(large.context, scope, large.window.checkpoint)?.size,
  ).toBe(HISTORY_WINDOW_KEEP_SOURCES + 1);
  // The notice is a labelled block after the transcript. It says nothing was
  // reviewed and ties a read to the request.
  const notice = large.user.slice(
    large.user.indexOf("runtime:history_not_shown:\n"),
  );
  expect(
    large.user.indexOf(`original-${HISTORY_WINDOW_MAX_SOURCES}.`),
  ).toBeLessThan(large.user.indexOf("runtime:history_not_shown:\n"));
  expect(notice).toContain(`${boundary} earlier messages`);
  expect(notice).toContain("deferred by position, not reviewed");
  expect(notice).toContain("that alone is no reason to read them");
  expect(notice).toContain(
    `history:h1–history:h${HISTORY_WINDOW_MAX_SOURCES + 1}`,
  );
  expect(large.user).not.toContain("background review");
  // The boundary no longer forbids the read the notice describes.
  expect(large.user).not.toContain("do not invent a history search");
  expect(large.user).toContain("as the history notice says");
});

it("advances a batch at a time, so the transcript between advances only grows at its end", () => {
  const boundaries = new Set<number>();
  let previous = "";
  let previousBoundary = -1;
  for (let count = 41; count <= 120; count++) {
    const { window, user } = stage1(count);
    const boundary = window.checkpoint?.reviewedCount ?? 0;
    const visible = count - boundary;
    expect(visible).toBeGreaterThanOrEqual(HISTORY_WINDOW_KEEP_SOURCES);
    expect(visible).toBeLessThanOrEqual(HISTORY_WINDOW_MAX_SOURCES);
    const transcript = user.slice(
      user.indexOf("# Conversation"),
      user.indexOf(`original-${count - 1}.`),
    );
    if (boundary === previousBoundary)
      expect(transcript.startsWith(previous)).toBe(true);
    previous = transcript;
    previousBoundary = boundary;
    boundaries.add(boundary);
  }
  expect([...boundaries]).toEqual([20, 40, 60, 80, 100]);
});

it("starts the window on a user message, never on a reply whose request is deferred", () => {
  // Two user messages in a row at 10 and 11 shift every later reply onto an
  // even index, so the batch boundary at 40 lands on a reply.
  const shifted = (index: number) =>
    index <= 10 ? alternate(index) : alternate(index + 1);
  const { window, user } = stage1(60, [], shifted);
  expect(shifted(40)).toBe("agent");
  expect(window.checkpoint?.reviewedCount).toBe(41);
  const transcript = user.slice(user.indexOf("# Conversation"));
  expect(transcript).not.toContain("original-40.");
  expect(transcript.indexOf("original-41.")).toBeLessThan(
    transcript.indexOf("original-42."),
  );
});

it("keeps deferred user messages with standing wording inline, up to a bound", () => {
  const standing = new Map([
    [2, "Always read a text back to me before sending it."],
    [6, "From now on call me Sam."],
    // A reply repeating the wording is not the owner's instruction.
    [7, "I will always read texts back."],
  ]);
  const { user, window } = stage1(
    80,
    [],
    alternate,
    (index) => standing.get(index) ?? `original-${index}.`,
  );
  expect(window.checkpoint?.reviewedCount).toBe(60);
  expect(window.checkpoint?.retainedEventIds).toEqual([
    "history:2",
    "history:6",
  ]);
  expect(user).toContain("Always read a text back to me before sending it.");
  expect(user).toContain("From now on call me Sam.");
  expect(user).not.toContain("I will always read texts back.");
  expect(user).not.toContain("original-4.");
  const many = stage1(
    200,
    [],
    alternate,
    (index) => `never do thing ${index}.`,
  );
  expect(many.window.checkpoint?.retainedEventIds).toHaveLength(
    HISTORY_WINDOW_STANDING_SOURCES,
  );
});

it("bounds a room whose last exchange is a long run of user messages", () => {
  const context = room(200, [], () => "user");
  const { checkpoint } = windowHistoryRetention(context, scope, null);
  expect(checkpoint?.reviewedCount).toBe(180);
  expect(visibleHistoryEventIds(context, scope, checkpoint)?.size).toBe(
    HISTORY_WINDOW_MAX_SOURCES,
  );
});

it("keeps what a reviewer retained and never moves behind its boundary", () => {
  const reviewedRoom = room(30);
  const prepared = prepareHistoryRetention(
    reviewedRoom,
    scope,
    null,
    "evidence",
    30,
  );
  const stored = applyHistoryRetentionReview(prepared, {
    sourceSetId: prepared.sourceSetId,
    complete: true,
    retainSourceIds: ["h1"],
    deferSourceIds: prepared.candidates.slice(1).map((source) => source.id),
    uncertainSourceIds: [],
    dependencyGroups: [],
  });
  // The reviewer is keeping up: its checkpoint is used unchanged.
  expect(windowHistoryRetention(room(50), scope, stored)).toEqual({
    checkpoint: stored,
    windowed: false,
  });
  // Unreviewed originals piled up past the limit.
  const context = room(80);
  const window = windowHistoryRetention(context, scope, stored);
  expect(window.windowed).toBe(true);
  expect(window.checkpoint?.reviewedCount).toBe(60);
  expect(window.checkpoint?.retainedEventIds).toEqual(["history:0"]);
  const visible = visibleHistoryEventIds(context, scope, window.checkpoint);
  expect(visible?.has("history:0")).toBe(true);
  expect(visible?.has("history:59")).toBe(false);
  expect(visible?.has("history:60")).toBe(true);
});

it("lets request-bound notes follow a deferred request and carries the flag to later stages", () => {
  const interrupted = (request: number, reply: number) =>
    segment(
      `interrupted-turn:${reply}`,
      "runtime:interrupted_turn",
      JSON.stringify({
        requestSourceEventId: `history:${request}`,
        requestText: `interrupted-${request}`,
        responseGeneration: "interrupted",
      }),
    );
  const continuation = (request: number) =>
    segment(
      `historical-read-continuations:${request}`,
      "runtime:historical_read_continuations",
      JSON.stringify({
        requestSourceEventId: `history:${request}`,
        scope: "Past exact read ranges.",
        reads: [`continuation-${request}`],
      }),
    );
  const { context, history, user } = stage1(60, [
    segment(
      "historical-navigation-scope",
      "runtime:historical_navigation_scope",
      "navigation-scope-sentence",
    ),
    segment(
      "historical-navigation:10",
      "runtime:historical_navigation",
      JSON.stringify({ requestSourceEventId: "history:10", navigation: [] }),
    ),
    interrupted(2, 3),
    // The request is deferred, but its cut-off reply is the window's first line.
    interrupted(38, 40),
    interrupted(58, 59),
    continuation(12),
    continuation(44),
  ]);
  expect(user).not.toContain("interrupted-2");
  expect(user).toContain("interrupted-38");
  expect(user).toContain("interrupted-58");
  expect(user).not.toContain("continuation-12");
  expect(user).toContain("continuation-44");
  // Its only entry left with request 10, so the scope sentence goes too.
  expect(user).not.toContain("navigation-scope-sentence");
  const planner = projectBackgroundHistory(
    withBackgroundHistory(context, history),
  );
  expect(planner).toMatchObject({
    applied: true,
    windowed: true,
    omittedSourceCount: 40,
  });
  expect(JSON.stringify(planner.context.events)).not.toContain("interrupted-2");
  // The canonical context is untouched; a history read restores everything.
  expect(JSON.stringify(context.events)).toContain("interrupted-2");
});

it("orders the request by how often each part changes", () => {
  const observation = (revision: number) =>
    segment(
      "current-client-observation",
      CLIENT_OBSERVATION_SEGMENT_LABEL,
      `clientDevice.context: {"view":"home","revision":${revision}}`,
    );
  const fixed: ContextEvent = {
    id: "capability",
    type: "instruction",
    source: "message-service",
    stable: false,
    content: "phone-capability-text",
  };
  const effects = segment(
    "historical-effects:44",
    "runtime:historical_effects",
    JSON.stringify({
      requestSourceEventId: "history:44",
      scope: "Past recorded outcomes only.",
      outcomes: [{ actionName: "NOTES_CREATE", success: true, receipt: {} }],
    }),
  );
  const navigation = segment(
    "historical-navigation:46",
    "runtime:historical_navigation",
    JSON.stringify({ requestSourceEventId: "history:46", navigation: [] }),
  );
  const turn = (revision: number, count: number) =>
    stage1(count, [navigation, observation(revision), effects, fixed]).user;
  const first = turn(1, 48);
  const order = [
    "phone-capability-text",
    "runtime:historical_effects",
    "runtime:historical_navigation",
    "as the history notice says",
    "# Conversation",
    "runtime:history_not_shown",
    `${CLIENT_OBSERVATION_SEGMENT_LABEL}:`,
  ].map((marker) => first.indexOf(marker));
  expect(order.every((at) => at >= 0)).toBe(true);
  expect(order).toEqual([...order].sort((a, b) => a - b));
  // A new screen and two more messages leave everything through the earlier
  // transcript untouched.
  const second = turn(2, 50);
  let shared = 0;
  while (shared < first.length && first[shared] === second[shared]) shared++;
  expect(first.slice(0, shared)).toContain("original-47.");
});

it("tells the planner and the evaluator that the window is positional and ties restoring to a named gap", async () => {
  const { context, history } = stage1(60);
  const full = withBackgroundHistory(context, history);
  const planner: string[] = [];
  await runPlannerLoop({
    context: full,
    tools: [{ name: "READ", description: "Read a record" }],
    runtime: {
      useModel: async (_type: unknown, params: { messages: unknown }) => {
        planner.push(JSON.stringify(params.messages));
        return {
          text: "",
          toolCalls: [
            {
              id: "reply",
              name: "REPLY",
              arguments: { text: "Done.", eliza_turn_scope: "final" },
            },
          ],
        };
      },
    },
    executeToolCall: async () => ({ success: true, text: "Read." }),
    evaluate: async () => ({
      success: true,
      decision: "FINISH",
      thought: "Replied.",
      messageToUser: "Done.",
    }),
  });
  const evaluator: string[] = [];
  await runEvaluator({
    context: full,
    trajectory: {
      context: full,
      modelBaseContext: full,
      steps: [],
      archivedSteps: [],
      plannedQueue: [],
      evaluatorOutputs: [],
    },
    runtime: {
      useModel: async (_type: unknown, params: unknown) => {
        evaluator.push(JSON.stringify(params));
        return JSON.stringify({
          thought: "Done",
          success: true,
          decision: "FINISH",
        });
      },
    },
    effects: { messageToUser: async () => {}, copyToClipboard: async () => {} },
  });
  for (const sent of [planner[0], evaluator[0]]) {
    expect(sent).toContain("original-59.");
    expect(sent).not.toContain("original-0.");
    expect(sent).toContain(
      "40 earlier messages are not shown; they were deferred by position, not reviewed.",
    );
    // A reviewer's notice would claim retained constraints nobody selected, and
    // "uncertain" would justify restoring the whole room on every turn.
    expect(sent).not.toContain("background review");
    expect(sent).not.toContain("or uncertain");
  }
  expect(planner[0]).toContain(
    "Omitted dialogue is not itself a missing dependency",
  );
  expect(evaluator[0]).toContain(
    "Omitted dialogue is not itself missing evidence",
  );
});

afterEach(() => vi.unstubAllEnvs());

function phoneTurn(
  responses: unknown[],
  count: number,
  messageId: string,
  text: (index: number) => string = (index) => `original-${index}.`,
) {
  const runtime = makeRuntime(responses);
  Object.assign(runtime, { evaluators: [historyRetentionEvaluator] });
  runtime.getCache = async () => undefined;
  const message = makeMessage({ channelType: ChannelType.DM, text: "hi" });
  message.id = messageId as Memory["id"];
  message.createdAt = 1000;
  const rows: Memory[] = Array.from({ length: count }, (_, i) => ({
    ...message,
    id: `00000000-0000-0000-0000-${String(100 + i).padStart(12, "0")}` as Memory["id"],
    createdAt: i + 1,
    entityId: i % 2 ? runtime.agentId : message.entityId,
    content: { ...message.content, text: text(i) },
  }));
  const state = makeState();
  state.data.providers = {
    RECENT_MESSAGES: { data: { recentMessages: rows } },
  };
  runtime.composeState = vi.fn(async () => structuredClone(state));
  return { runtime, message, state };
}
const reply = () => stage1Response({ contexts: ["simple"], replyText: "hi" });

it.each([
  ["android", false],
  ["", true],
])(
  "Stage 1 on platform %j sends the whole room: %j",
  async (platform, whole) => {
    vi.stubEnv("ELIZA_PLATFORM", platform);
    const { runtime, message, state } = phoneTurn(
      [reply()],
      60,
      "00000000-0000-0000-0000-000000000001",
    );
    await runStage1({ runtime, message, state });
    const sent = JSON.stringify(useModelCalls(runtime)[0]);
    expect(sent).toContain("original-59.");
    expect(sent.includes("original-0.")).toBe(whole);
    expect(sent.includes("deferred by position")).toBe(!whole);
  },
);

it("sends the same Stage-1 tools on consecutive windowed turns", async () => {
  vi.stubEnv("ELIZA_PLATFORM", "android");
  const tools = [];
  for (const [count, id] of [
    [60, "00000000-0000-0000-0000-000000000001"],
    [62, "00000000-0000-0000-0000-000000000009"],
  ] as const) {
    const { runtime, message, state } = phoneTurn([reply()], count, id);
    await runStage1({ runtime, message, state });
    tools.push(
      (useModelCalls(runtime)[0][1] as { tools: { name: string }[] }).tools,
    );
  }
  expect(tools[0].map((tool) => tool.name)).toEqual([
    "HANDLE_RESPONSE",
    "READ_CONTEXT",
  ]);
  // Tool definitions precede the conversation in a provider's cached prefix.
  expect(tools[1]).toEqual(tools[0]);
});

it("does not restore the whole room when the model returns no decision", async () => {
  vi.stubEnv("ELIZA_PLATFORM", "android");
  const { runtime, message, state } = phoneTurn(
    ["Just some prose.", reply(), reply()],
    60,
    "00000000-0000-0000-0000-000000000001",
  );
  await runStage1({ runtime, message, state });
  for (const call of useModelCalls(runtime))
    expect(JSON.stringify(call)).not.toContain("original-0.");
});

// The window only defers. What makes it safe is that the same turn can still
// read a deferred message back through the tool it is already offered.
it.each([
  ["by position", { kind: "history-source", sourceOrdinals: [3] }],
  [
    "by its words",
    { kind: "history-search", speaker: "all", query: "original-2." },
  ],
])(
  "returns a deferred message to the same turn when the model reads it %s",
  async (_label, read) => {
    vi.stubEnv("ELIZA_PLATFORM", "android");
    const { runtime, message, state } = phoneTurn(
      [
        {
          text: "",
          toolCalls: [
            {
              name: "READ_CONTEXT",
              arguments: { reads: [read], acknowledgment: "" },
            },
          ],
        },
        reply(),
      ],
      60,
      "00000000-0000-0000-0000-000000000001",
    );
    await runStage1({ runtime, message, state });
    const [first, second] = useModelCalls(runtime).map((call) =>
      JSON.stringify(call),
    );
    expect(first).not.toContain("original-2.");
    expect(first).toContain("history:h1");
    expect(second).toContain("original-2.");
    // The read adds what was asked for, not the room.
    expect(second).not.toContain("original-7.");
  },
);

// A model searches for a subject, not for a phrase the conversation contains.
// On a real model three of five such searches found nothing under literal
// matching, and it then told the owner the fact had never been given.
const said: Record<number, string> = {
  2: "The wifi password at the cabin is pinecone-42.",
  4: "Draft this for my landlord: the kitchen tap is dripping again.",
  6: "Is the cabin far from the lake?",
};
const saidAt = (index: number) => said[index] ?? `original-${index}.`;

it("finds a deferred message by the words of a query that matches nothing literally", async () => {
  vi.stubEnv("ELIZA_PLATFORM", "android");
  const { runtime, message, state } = phoneTurn(
    [
      {
        text: "",
        toolCalls: [
          {
            name: "READ_CONTEXT",
            arguments: {
              reads: [
                {
                  kind: "history-search",
                  speaker: "all",
                  query: "cabin wifi password",
                },
              ],
              acknowledgment: "",
            },
          },
        ],
      },
      reply(),
    ],
    60,
    "00000000-0000-0000-0000-000000000001",
    saidAt,
  );
  await runStage1({ runtime, message, state });
  const [first, second] = useModelCalls(runtime).map((call) =>
    JSON.stringify(call),
  );
  expect(first).not.toContain("pinecone-42");
  expect(second).toContain("pinecone-42");
  // The receipt says the hit is by words, and one shared word is not a hit.
  expect(second).toContain('\\"match\\":\\"words\\"');
  expect(second).not.toContain("far from the lake");
});

it("keeps literal hits literal and needs two shared words and half the query", () => {
  const { context, history } = stage1(60, [], alternate, saidAt);
  const search = (query: string) =>
    loadHistoryReferences(context, history, [`history:search:${query}`])
      .evidence?.searchResults?.[0];
  // A phrase the conversation contains is a literal hit, as before.
  expect(search("wifi password")).toMatchObject({
    matchedSourceIds: [expect.any(String)],
  });
  expect(search("wifi password")).not.toHaveProperty("match");
  expect(search("draft note landlord")).toMatchObject({
    match: "words",
    matchedSourceIds: [expect.any(String)],
  });
  // One word of two, or fewer than half of a longer query, finds nothing.
  for (const query of [
    "cabin heating",
    "landlord phone number email address",
    "zebra",
  ]) {
    const result = search(query);
    expect([query, result?.matchedSourceIds]).toEqual([query, []]);
    expect(result).not.toHaveProperty("match");
  }
  expect(
    loadHistoryReferences(context, history, ["history:search:cabin heating"])
      .evidence?.emptySearchResults,
  ).toHaveLength(1);
});

it("supplies only the newest few originals when many share the same words", () => {
  const { context, history } = stage1(
    60,
    [],
    alternate,
    (index) => `the plumber said tuesday, note ${index}.`,
  );
  const result = loadHistoryReferences(context, history, [
    "history:search:plumber tuesday visit",
  ]).evidence?.searchResults?.[0];
  expect(result?.match).toBe("words");
  expect(result?.matchedSourceIds).toHaveLength(5);
});

// The window hides "my gate code is 4471" from "what's my gate code again?".
// Reading is the model's job; on a live model it skipped the read and denied
// having the fact in about one such request in eight.
it("shows a deferred exchange that shares distinctive words with the request, without a read", async () => {
  vi.stubEnv("ELIZA_PLATFORM", "android");
  const text = (index: number) =>
    ({
      2: "Which dishwasher should I buy?",
      3: "The Bosch 500 series; it is the quietest in your budget.",
      4: "For future reference, my gate code is 4471#.",
    })[index] ?? `original-${index}.`;
  const turn = async (request: string) => {
    const { runtime, message, state } = phoneTurn(
      [reply()],
      60,
      "00000000-0000-0000-0000-000000000001",
      text,
    );
    message.content.text = request;
    await runStage1({ runtime, message, state });
    return JSON.stringify(useModelCalls(runtime)[0]);
  };
  const gate = await turn("What's my gate code again?");
  expect(gate).toContain("4471#");
  // The other half of the exchange comes with it; unrelated history does not.
  expect(gate).toContain("original-5.");
  expect(gate).not.toContain("Bosch");
  expect(gate).not.toContain("original-7.");
  // A question recalls its answer, which shares no word with the request.
  expect(await turn("Which dishwasher did you recommend?")).toContain(
    "Bosch 500",
  );
  // One shared word, a word that only sits inside another ("code" in
  // "barcodes"), or only words the conversation is full of, recalls nothing.
  for (const request of [
    "Is the gate open?",
    "Do gateways read barcodes?",
    "original-1. original-7. hello",
  ])
    expect(await turn(request)).not.toContain("4471#");
  // An inflected form still counts; a longer word that merely starts the
  // same way does not.
  expect(await turn("Which gates take codes?")).toContain("4471#");
  expect(await turn("Is the gatehouse codebook here?")).not.toContain("4471#");
  // A pasted document is not matched word by word against the conversation.
  expect(
    await turn(
      `gate code ${Array.from({ length: 60 }, (_, i) => `term${i}x`).join(" ")}`,
    ),
  ).not.toContain("4471#");
});

it("recalls only what is deferred, at most three exchanges, and counts what is left", () => {
  const notes: Record<number, string> = {
    2: "the plumber comes tuesday.",
    4: "the dentist moved to friday.",
    6: "the roofer quoted ninety.",
    8: "the tailor needs a fitting.",
  };
  const { context, history } = stage1(
    60,
    [],
    alternate,
    (index) => notes[index] ?? `original-${index}.`,
  );
  if (!history) throw new Error("no deferred history");
  const recalled = recallDeferredHistory(
    context,
    history,
    "plumber tuesday, dentist friday, roofer ninety, tailor fitting?",
  );
  // Four messages share two distinctive words; the three newest come back,
  // each with its reply.
  expect(recalled.loadedSourceIds.size - history.loadedSourceIds.size).toBe(6);
  expect(recalled.windowed).toBe(history.windowed);
  const shown = projectBackgroundHistory(
    withBackgroundHistory(context, recalled),
  );
  expect(shown.omittedSourceCount).toBe(
    projectBackgroundHistory(withBackgroundHistory(context, history))
      .omittedSourceCount - 6,
  );
  expect(
    JSON.stringify(shown.context.events).includes("the plumber comes"),
  ).toBe(false);
  // Words most of the conversation contains recall nothing.
  expect(recallDeferredHistory(context, history, "the original thanks")).toBe(
    history,
  );
});

// Words every message contains must not decide a search, the messages already
// in view must not crowd out the deferred one it was for, and finding only
// what recall supplied must not bring the whole room back.
const chatter = (index: number) =>
  ({
    4: "For future reference, my gate code is 4471#.",
  })[index] ?? `what did you say about the weather on day ${index}?`;

it("decides a search by its distinctive words and prefers originals not in view", () => {
  const { context, history } = stage1(60, [], alternate, chatter);
  if (!history) throw new Error("no deferred history");
  const bound = (query: string) =>
    loadHistoryReferences(context, history, [`history:search:${query}`]);
  const found = bound("what did you say about the gate code").evidence
    ?.searchResults?.[0];
  expect(found).toMatchObject({ match: "words" });
  expect(found?.matchedSourceIds).toHaveLength(1);
  // A query of nothing but the conversation's common words, in an order no
  // message uses, ties everywhere: the newest few that are deferred come
  // back, not the ones on screen.
  const common = bound("say what you did").evidence;
  const ids = common?.searchResults?.[0].matchedSourceIds ?? [];
  expect(ids).toHaveLength(5);
  const shown = projectBackgroundHistory(
    withBackgroundHistory(context, history),
  );
  const visible = JSON.stringify(shown.context.events);
  for (const day of [35, 36, 37, 38, 39])
    expect(visible).not.toContain(`weather on day ${day}?`);
  const loaded = JSON.stringify(
    projectBackgroundHistory(
      withBackgroundHistory(context, { ...history, ...common }),
    ).context.events,
  );
  expect(loaded).toContain("weather on day 39?");
});

it("keeps the window when a search finds only what recall supplied, and restores the room after two empty searches", () => {
  const { context, history } = stage1(60, [], alternate, chatter);
  if (!history) throw new Error("no deferred history");
  const recalled = recallDeferredHistory(
    context,
    history,
    "What's my gate code again?",
  );
  expect(recalled.loadedSourceIds.size).toBeGreaterThan(
    history.loadedSourceIds.size,
  );
  // The model's first read of what the host recalled is a first read, by
  // search or by reference; its second is the repeat that restores the room.
  const checked = loadHistoryReferences(context, recalled, [
    "history:search:gate code",
  ]);
  expect(checked.projection).toBeDefined();
  expect(checked.evidence?.searchResults?.[0].matchedSourceIds).toHaveLength(1);
  const [gate] = checked.evidence?.searchResults?.[0].matchedSourceIds ?? [];
  expect(
    requestedHistory(context, recalled, null, [`history:${gate}`], true),
  ).toEqual([`history:${gate}`]);
  expect(
    loadHistoryReferences(context, checked.projection, [
      "history:search:gate code",
    ]).projection,
  ).toBeUndefined();
  expect(
    requestedHistory(
      context,
      checked.projection,
      null,
      [`history:${gate}`],
      true,
    ),
  ).toContain("history:all");
  const first = loadHistoryReferences(context, recalled, [
    "history:search:zebra crossing",
  ]);
  expect(first.projection).toBeDefined();
  expect(
    loadHistoryReferences(context, first.projection, [
      "history:search:giraffe parade",
    ]).projection,
  ).toBeUndefined();
});
