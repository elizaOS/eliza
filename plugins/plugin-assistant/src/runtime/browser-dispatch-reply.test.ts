/**
 * A native browser reload/back/forward is accepted by the phone's renderer
 * but never reports completion, and the host exposes no read command to
 * confirm it. Live Pixel v619: the evaluator classified the turn as an applied
 * change, the receipt guard rejected every reply, and the turn ended with the
 * synthetic "part of it may already be done" failure. These tests drive the
 * real planner loop and evaluator with a scripted model.
 */
import { describe, expect, it } from "vitest";
import { isDeliveredNavigationOnlyTurn } from "./nav-evaluator-eligibility.ts";
import { runPlannerLoop } from "./planner-loop.ts";

const RELOAD_TEXT =
  "I asked the browser to reload the page. It may still be loading.";

/** Model prose that claims the page finished, which the receipt only dispatched. */
const COMPLETION_CLAIMS = [
  "Reloaded the page.",
  "The page has finished reloading.",
  "Done, the page reloaded.",
];

/** The BROWSER result plugin-browser's native handler returns for a dispatch-only navigation receipt. */
function dispatchedBrowserResult(subaction = "reload") {
  const result = {
    targetId: "native-client",
    mode: "web",
    subaction,
    value: { dispatched: true, completed: false, requiresReadback: false },
  };
  return {
    success: true,
    text: JSON.stringify(result),
    userFacingText: RELOAD_TEXT,
    verifiedUserFacing: true,
    turnComplete: true,
    data: { actionName: "BROWSER", executionStatus: "dispatched", result },
  };
}

/** The unchanged result the native handler returns for a dispatched page interaction. */
function dispatchedInteractionResult(subaction: string) {
  const result = {
    targetId: "native-client",
    mode: "web",
    subaction,
    value: { dispatched: true, completed: false, requiresReadback: true },
  };
  return {
    success: true,
    text: JSON.stringify(result),
    data: { actionName: "BROWSER", result },
  };
}

type ToolTurn = {
  name: string;
  args: Record<string, unknown>;
  result: unknown;
};

type Script = {
  /** The evaluator's FINISH prose and effect classification. */
  evaluatorMessage?: string;
  evaluatorStatus?: "none" | "non_applied";
  /** The planner's reply text, written alongside the tool call and after it. */
  plannerMessage?: string;
  /** The native planner's turn scope on the tool call. */
  scope?: "final" | "more_work_pending";
};

async function run(
  turn: ToolTurn,
  intents = ["Reload the page"],
  script: Script = {},
) {
  const plannerMessage = script.plannerMessage ?? "Reloaded the page.";
  const enums: unknown[][] = [];
  let toolCalls = 0;
  let executed = 0;
  const context = {
    id: "browser-dispatch",
    events: [
      {
        id: "stage1",
        type: "message_handler",
        source: "message-service",
        metadata: { plan: { intents } },
      },
    ],
  };
  const pending = runPlannerLoop({
    context,
    tools: [
      {
        name: turn.name,
        parameters: { type: "object", properties: {} },
      },
    ],
    runtime: {
      useModel: async (
        _type: unknown,
        args: {
          responseSchema?: {
            properties?: { replyEffectStatus?: { enum?: unknown[] } };
          };
        },
      ) => {
        const status = args.responseSchema?.properties?.replyEffectStatus;
        if (status) {
          // The evaluator model on device: it reads a reload as a completed
          // change whenever the schema lets it, and leaves messageToUser empty
          // to approve the verified tool text.
          const allowed = status.enum ?? [];
          enums.push(allowed);
          return JSON.stringify({
            thought: "The browser command ran.",
            success: true,
            decision: "FINISH",
            requestFullyCovered: true,
            replyEffectStatus: allowed.includes("applied")
              ? "applied"
              : (script.evaluatorStatus ?? "none"),
            messageToUser: script.evaluatorMessage ?? "",
          });
        }
        if (toolCalls++ === 0)
          return {
            text: plannerMessage,
            toolCalls: [
              {
                id: "call-1",
                name: turn.name,
                arguments: {
                  ...turn.args,
                  eliza_turn_scope: script.scope ?? "final",
                },
              },
            ],
          };
        return JSON.stringify({
          completed: true,
          toolCalls: [],
          messageToUser: plannerMessage,
        });
      },
    },
    executeToolCall: () => {
      executed++;
      return structuredClone(turn.result);
    },
  } as never);
  const outcome = await pending.then(
    (result) => ({ result, error: undefined }),
    (error: unknown) => ({ result: undefined, error }),
  );
  return { ...outcome, enums, executed };
}

describe("dispatch-only native browser navigation", () => {
  it.each(["reload", "back", "forward", "navigate", "open"])(
    "finishes a successful %s with the tool's honest text alone",
    async (subaction) => {
      const h = await run({
        name: "BROWSER",
        args: { action: subaction },
        result: dispatchedBrowserResult(subaction),
      });
      expect(h.executed).toBe(1);
      // One evaluator call: its applied verdict on a dispatch-only step reads
      // as none instead of sending the reply back for another round.
      expect(h.enums).toHaveLength(1);
      expect(h.result?.status).toBe("finished");
      expect(h.result?.evaluator).toMatchObject({
        decision: "FINISH",
        replyEffectStatus: "none",
      });
      expect(h.result?.finalMessage).toBe(RELOAD_TEXT);
      expect(h.result?.terminalFailure).toBeUndefined();
    },
  );

  it("finishes on the tool's own text without an evaluator call when no intent was declared", async () => {
    const h = await run(
      {
        name: "BROWSER",
        args: { action: "reload" },
        result: dispatchedBrowserResult(),
      },
      [],
      { evaluatorMessage: "The page has finished reloading." },
    );
    expect(h.enums).toEqual([]);
    expect(h.result?.evaluator).toMatchObject({
      decision: "FINISH",
      messageToUser: RELOAD_TEXT,
    });
    expect(h.result?.finalMessage).toBe(RELOAD_TEXT);
  });

  const echoes = COMPLETION_CLAIMS.flatMap((claim) =>
    (["none", "non_applied"] as const).map(
      (status) => [claim, status] as const,
    ),
  );

  it.each(echoes)(
    "never appends a completion claim when the planner and evaluator would say %j (%s)",
    async (claim, status) => {
      const h = await run(
        {
          name: "BROWSER",
          args: { action: "reload" },
          result: dispatchedBrowserResult(),
        },
        ["Reload the page"],
        {
          plannerMessage: claim,
          evaluatorMessage: claim,
          evaluatorStatus: status,
        },
      );
      expect(h.result?.status).toBe("finished");
      expect(h.result?.finalMessage).toBe(RELOAD_TEXT);
      for (const other of COMPLETION_CLAIMS)
        expect(h.result?.finalMessage).not.toContain(other);
      expect(h.result?.terminalFailure).toBeUndefined();
    },
  );

  it("lets the planner keep the turn open; the evaluator's applied then reads as none", async () => {
    const h = await run(
      {
        name: "BROWSER",
        args: { action: "reload" },
        result: dispatchedBrowserResult(),
      },
      ["Reload the page"],
      { scope: "more_work_pending" },
    );
    expect(h.executed).toBe(1);
    expect(h.enums.length).toBeGreaterThan(0);
    // The schema is the same on every turn; the classification is enforced
    // after decoding instead.
    for (const allowed of h.enums)
      expect(allowed).toEqual(["none", "applied", "non_applied"]);
    expect(h.result?.evaluator?.replyEffectStatus).not.toBe("applied");
    expect(h.result?.terminalFailure).toBeUndefined();
  });

  it("keeps the receipt guard for a mutating action without receipts", async () => {
    const h = await run(
      {
        name: "NOTES_CREATE",
        args: { title: "groceries" },
        result: {
          success: true,
          text: "created",
          userFacingText: "Saved your note.",
          verifiedUserFacing: true,
          data: { actionName: "NOTES_CREATE" },
        },
      },
      ["Create a note"],
    );
    expect(h.enums[0]).toContain("applied");
    expect(h.result?.finalMessage).not.toBe("Saved your note.");
    expect(h.result?.terminalFailure).toMatchObject({
      code: "REPLY_GROUNDING_FAILED",
    });
  });

  it.each(["click", "fill"])(
    "keeps the receipt guard for a dispatched %s",
    async (subaction) => {
      const h = await run({
        name: "BROWSER",
        args: { action: subaction },
        result: dispatchedInteractionResult(subaction),
      });
      // A page interaction may have submitted something, so its result is
      // unchanged from before: every evaluation may classify it as applied,
      // the receipt guard rejects each such reply, and the turn stops on the
      // loop limit that the message pipeline turns into its failure warning.
      expect(h.enums.length).toBeGreaterThan(1);
      for (const allowed of h.enums) expect(allowed).toContain("applied");
      expect(h.result).toBeUndefined();
      expect(h.error).toMatchObject({
        name: "TrajectoryLimitExceeded",
        message: expect.stringContaining("terminal_only_continuations"),
      });
    },
  );
});

describe("dispatched browser navigation eligibility", () => {
  const trajectory = (result: unknown, name = "BROWSER") => ({
    context: { id: "t", events: [] },
    steps: [{ iteration: 1, toolCall: { id: "c", name, params: {} }, result }],
    archivedSteps: [],
    plannedQueue: [],
    outcomeIntents: ["Reload the page"],
    evaluatorOutputs: [],
  });
  const eligible = (value: unknown) =>
    Reflect.apply(isDeliveredNavigationOnlyTurn, undefined, [value]);

  it("recognises the typed dispatch marker on a single navigation step", () => {
    for (const subaction of ["reload", "back", "forward", "navigate", "open"])
      expect(eligible(trajectory(dispatchedBrowserResult(subaction)))).toBe(
        true,
      );
  });

  it("keeps current behaviour for failures, completed or unmarked results, interactions and mixed turns", () => {
    const cases: [
      string,
      (r: ReturnType<typeof dispatchedBrowserResult>) => unknown,
    ][] = [
      ["failed command", (r) => ({ ...r, success: false })],
      [
        "navigate that is not dispatch-only",
        (r) => ({
          ...r,
          data: {
            actionName: "BROWSER",
            result: {
              ...r.data.result,
              subaction: "navigate",
              value: { completed: true },
            },
          },
        }),
      ],
      [
        "missing marker",
        (r) => ({ ...r, data: { ...r.data, executionStatus: undefined } }),
      ],
      [
        "completed receipt",
        (r) => ({
          ...r,
          data: {
            ...r.data,
            result: {
              ...r.data.result,
              value: { dispatched: true, completed: true },
            },
          },
        }),
      ],
      [
        "page interaction",
        (r) => ({
          ...r,
          data: { ...r.data, result: { ...r.data.result, subaction: "fill" } },
        }),
      ],
      [
        "effect receipts",
        (r) => ({ ...r, effectReceipts: [{ outcome: "applied" }] }),
      ],
    ];
    for (const [label, change] of cases)
      expect([
        label,
        eligible(trajectory(change(dispatchedBrowserResult()))),
      ]).toEqual([label, false]);
    expect(
      eligible(trajectory(dispatchedBrowserResult(), "NOTES_CREATE")),
    ).toBe(false);
    const mixed = trajectory(dispatchedBrowserResult());
    mixed.outcomeIntents.push("Create a note");
    expect(eligible(mixed)).toBe(false);
    const queued = trajectory(dispatchedBrowserResult());
    Object.assign(queued, { plannedQueue: [{ name: "NOTES_CREATE" }] });
    expect(eligible(queued)).toBe(false);
  });
});
