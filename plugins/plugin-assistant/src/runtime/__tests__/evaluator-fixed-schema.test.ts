/**
 * A provider renders the evaluator's response schema straight after its system
 * prompt. A schema that names this turn's intents or narrows this turn's reply
 * statuses therefore puts the whole conversation behind a changed byte, and
 * none of it is reused from the evaluator call before. The schema is the same
 * on every turn; what the turn allows is said in the decision state and
 * enforced on the decoded verdict.
 */
import type {
  ContextObject,
  EvaluatorOutput,
  JSONSchema,
  PlannerTrajectory,
} from "@elizaos/core";
import { expect, it } from "vitest";
import { runEvaluator, validatedOutcomeCoverage } from "../evaluator.ts";
import navigation from "../navigation-replay.fixture.json";

const NAVIGATION_ONLY_LINE =
  "replyEffectStatus: none or non_applied. This turn delivered view navigation only and committed no effect receipt, so applied has no proof.";

function contextFor(request: string): ContextObject {
  return {
    id: "turn",
    events: [
      {
        id: "current",
        type: "message",
        message: { id: "current", role: "user", content: request },
      },
    ],
  };
}

function turn(intents: number): PlannerTrajectory {
  const context = contextFor("add milk");
  return {
    context,
    modelBaseContext: context,
    outcomeIntents: Array.from(
      { length: intents },
      (_, index) => `do thing ${index + 1}`,
    ),
    steps: [],
    archivedSteps: [],
    plannedQueue: [],
    evaluatorOutputs: [],
  } as PlannerTrajectory;
}

function navigationTurn(): PlannerTrajectory {
  const context = contextFor("Open the Notes view");
  return {
    ...structuredClone(navigation.trajectory),
    context,
    modelBaseContext: context,
  } as unknown as PlannerTrajectory;
}

async function evaluate(
  trajectory: PlannerTrajectory,
  options: {
    verdict?: Record<string, unknown>;
    /** The model's raw text, when it is not just the verdict. */
    reply?: string;
    hasUnresolvedToolFailure?: boolean;
  } = {},
) {
  const requests: {
    responseSchema: JSONSchema;
    messages: { role: string; content: unknown }[];
  }[] = [];
  const output = await runEvaluator({
    context: trajectory.context,
    trajectory,
    ...(options.hasUnresolvedToolFailure
      ? { hasUnresolvedToolFailure: true }
      : {}),
    runtime: {
      useModel: async (_type: unknown, request: (typeof requests)[number]) => {
        requests.push(request);
        if (options.reply !== undefined) return options.reply;
        return JSON.stringify(
          options.verdict ?? {
            thought: "Done",
            success: true,
            decision: "FINISH",
            replyEffectStatus: "none",
            messageToUser: "",
          },
        );
      },
    },
  } as never);
  expect(requests).toHaveLength(1);
  return {
    output,
    schema: requests[0].responseSchema,
    decisionState: String(requests[0].messages.at(-1)?.content),
  };
}

function intentIdEnum(schema: JSONSchema): unknown {
  const items = schema.properties?.outcomeCoverage?.items;
  return Array.isArray(items) ? undefined : items?.properties?.intentId?.enum;
}

it("sends one response schema whatever the turn's intents and work are", async () => {
  const schemas = [
    ...(await Promise.all(
      [0, 1, 2, 5].map(
        async (intents) => (await evaluate(turn(intents))).schema,
      ),
    )),
    (await evaluate(navigationTurn())).schema,
  ];
  for (const schema of schemas)
    expect(JSON.stringify(schema)).toBe(JSON.stringify(schemas[0]));
  expect(intentIdEnum(schemas[0])).toEqual(
    Array.from({ length: 8 }, (_, index) => `intent:${index + 1}`),
  );
  expect(schemas[0].properties?.replyEffectStatus?.enum).toEqual([
    "none",
    "applied",
    "non_applied",
  ]);
});

it("lists only the turn's own intents in the decision state and refuses coverage for any other id", async () => {
  const trajectory = turn(2);
  const { decisionState } = await evaluate(trajectory);
  expect(decisionState).toContain("intent:1: do thing 1\nintent:2: do thing 2");
  expect(decisionState).not.toContain("intent:3");
  trajectory.steps = [
    {
      iteration: 1,
      toolCall: { id: "call", name: "NOTES_UPDATE", params: {} },
      result: { success: true },
    },
  ];
  const covered = (intentIds: string[]): EvaluatorOutput => ({
    thought: "",
    success: true,
    decision: "FINISH",
    requestFullyCovered: true,
    outcomeCoverage: intentIds.map((intentId) => ({
      intentId,
      status: "completed",
      evidenceStepIds: ["step:1"],
    })),
  });
  const validated = (intentIds: string[]) =>
    validatedOutcomeCoverage({
      output: covered(intentIds),
      context: trajectory.context,
      trajectory,
    });
  expect(validated(["intent:1", "intent:2"])).toBe(true);
  // Both are ids the schema names; neither belongs to this turn.
  expect(validated(["intent:1", "intent:3"])).toBe(false);
  expect(validated(["intent:1", "intent:2", "intent:3"])).toBe(false);
});

/** A turn whose work is done: one successful step every intent can cite. */
function finishedTurn(intents: number): PlannerTrajectory {
  const trajectory = turn(intents);
  trajectory.steps = [
    {
      iteration: 1,
      toolCall: { id: "call", name: "NOTES_UPDATE", params: {} },
      result: { success: true },
    },
  ];
  return trajectory;
}

const row = (intentId: string, status = "completed") => ({
  intentId,
  status,
  evidenceStepIds: status === "completed" ? ["step:1"] : [],
});

const finished = (outcomeCoverage: ReturnType<typeof row>[]) => ({
  thought: "Everything asked for is recorded.",
  success: true,
  decision: "FINISH",
  requestFullyCovered: true,
  replyEffectStatus: "none",
  messageToUser: "Both are done.",
  outcomeCoverage,
});

it.each([
  ["one more id, pending", [row("intent:3", "pending")]],
  ["one more id, completed", [row("intent:3")]],
  [
    "every other id the schema names, blocked",
    [3, 4, 5, 6, 7, 8].map((position) => row(`intent:${position}`, "blocked")),
  ],
])(
  "judges a two-intent turn on its own two intents when the verdict adds %s",
  async (_name, extra) => {
    const trajectory = finishedTurn(2);
    const { output } = await evaluate(trajectory, {
      verdict: finished([row("intent:1"), row("intent:2"), ...extra]),
    });
    expect(output.decision).toBe("FINISH");
    expect(output.success).toBe(true);
    expect(output.requestFullyCovered).toBe(true);
    expect(output.messageToUser).toBe("Both are done.");
    expect(output.outcomeCoverage).toEqual([row("intent:1"), row("intent:2")]);
    expect(
      validatedOutcomeCoverage({
        output,
        context: trajectory.context,
        trajectory,
      }),
    ).toBe(true);
  },
);

it.each(["pending", "blocked", "completed"])(
  "drops a %s row from a turn that declared no intent",
  async (status) => {
    const trajectory = finishedTurn(0);
    const { output, decisionState } = await evaluate(trajectory, {
      verdict: {
        ...finished([row("intent:1", status)]),
        messageToUser: "Done.",
      },
    });
    expect(decisionState).not.toContain("intent:1");
    expect(output.decision).toBe("FINISH");
    expect(output.success).toBe(true);
    expect(output.requestFullyCovered).toBe(true);
    expect(output.messageToUser).toBe("Done.");
    // Nothing of this turn was judged: as if the verdict gave no coverage.
    expect(output.outcomeCoverage).toBeUndefined();
  },
);

it("reads a verdict whose only row names another turn's intent as giving no coverage", async () => {
  const { output } = await evaluate(finishedTurn(2), {
    verdict: finished([row("intent:3", "pending")]),
  });
  expect(output.outcomeCoverage).toBeUndefined();
  expect(output.messageToUser).toBe("Both are done.");
});

it("keeps an empty coverage list the model itself sent", async () => {
  const { output } = await evaluate(finishedTurn(2), {
    verdict: finished([]),
  });
  expect(output.outcomeCoverage).toEqual([]);
});

it("drops the row from a verdict that trails prose, too", async () => {
  const verdict = finished([
    row("intent:1"),
    row("intent:2"),
    row("intent:3", "pending"),
  ]);
  const { output } = await evaluate(finishedTurn(2), {
    reply: `Both updates are recorded.\n${JSON.stringify(verdict)}`,
  });
  expect(output.decision).toBe("FINISH");
  expect(output.success).toBe(true);
  expect(output.requestFullyCovered).toBe(true);
  expect(output.messageToUser).toBe("Both are done.");
});

it.each([
  ["one of the turn's own intents", 2, "intent:2"],
  ["the last intent of a turn longer than the fixed list", 9, "intent:9"],
  // Not an id the schema offers: the failure report for it is unchanged.
  ["an intent named by its text", 2, "do thing 2"],
  ["an id the schema does not spell", 2, "intent:03"],
])(
  "still reports failure for a pending row on %s",
  async (_name, intents, pending) => {
    const { output } = await evaluate(finishedTurn(intents), {
      verdict: finished([row("intent:1"), row(pending, "pending")]),
    });
    expect(output.decision).toBe("FINISH");
    expect(output.success).toBe(false);
    expect(output.requestFullyCovered).toBe(false);
    expect(output.outcomeCoverage).toContainEqual(row(pending, "pending"));
  },
);

it("names every intent of a turn that has more than the fixed list", async () => {
  const { schema, decisionState } = await evaluate(turn(9));
  expect(intentIdEnum(schema)).toEqual(
    Array.from({ length: 9 }, (_, index) => `intent:${index + 1}`),
  );
  expect(decisionState).toContain("intent:9: do thing 9");
});

it("tells a navigation-only turn that applied has no proof, and reads an applied verdict as none", async () => {
  // The recorded model verdict for this turn: applied, citing the navigation
  // handoff. The schema keeps applied so its bytes never change; the verdict
  // is classified as the narrower list used to force, so the honest
  // confirmation finishes in this round instead of going back for another.
  const { output, schema, decisionState } = await evaluate(navigationTurn(), {
    verdict: navigation.rawEvaluator,
  });
  expect(schema.properties?.replyEffectStatus?.enum).toContain("applied");
  expect(decisionState).toContain(NAVIGATION_ONLY_LINE);
  expect(output.decision).toBe("FINISH");
  expect(output.success).toBe(true);
  expect(output.replyEffectStatus).toBe("none");
  expect(output.messageToUser).toBe("Notes is open this time for real.");
  expect(output.effectReceiptIds).toEqual([]);
});

it("finishes a navigation-only turn whose reply claims no change", async () => {
  // The verdict still cites the navigation handoff as a receipt; it is not a
  // committed one, and a reply that claims no change needs none.
  const { output } = await evaluate(navigationTurn(), {
    verdict: {
      ...navigation.rawEvaluator,
      replyEffectStatus: "none",
      messageToUser: "Notes is open.",
    },
  });
  expect(output.decision).toBe("FINISH");
  expect(output.success).toBe(true);
  expect(output.messageToUser).toBe("Notes is open.");
  expect(output.effectReceiptIds).toEqual([]);
});

it("says nothing about reply status on a turn that did other work or failed", async () => {
  expect((await evaluate(turn(1))).decisionState).not.toContain(
    "replyEffectStatus:",
  );
  const withNote = navigationTurn();
  withNote.steps.push({
    iteration: 2,
    toolCall: { id: "note", name: "NOTES_CREATE", params: {} },
    result: { success: true },
  });
  expect((await evaluate(withNote)).decisionState).not.toContain(
    "replyEffectStatus:",
  );
  expect(
    (await evaluate(navigationTurn(), { hasUnresolvedToolFailure: true }))
      .decisionState,
  ).not.toContain("replyEffectStatus:");
});
