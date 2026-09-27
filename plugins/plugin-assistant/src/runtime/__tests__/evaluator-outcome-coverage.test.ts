/** Coverage binds semantic judgments to complete current-request intent and execution sources. */
import type {
  ContextObject,
  EvaluatorOutput,
  PlannerTrajectory,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  parseEvaluatorOutput,
  runEvaluator,
  validatedOutcomeCoverage,
} from "../evaluator";

function fixture() {
  const context: ContextObject = {
    id: "coverage",
    events: [
      {
        id: "handler",
        type: "message_handler",
        metadata: {
          plan: {
            intents: ["create the HTML file", "read and verify the HTML file"],
          },
        },
      },
    ],
  };
  const trajectory: PlannerTrajectory = {
    context,
    modelBaseContext: context,
    archivedSteps: [
      {
        iteration: 1,
        toolCall: { id: "write", name: "WRITE", params: {} },
        result: { success: true, text: "Written" },
      },
    ],
    steps: [
      {
        iteration: 2,
        toolCall: { id: "read", name: "READ", params: {} },
        result: { success: true, text: "Complete file contents" },
      },
    ],
    plannedQueue: [],
    evaluatorOutputs: [],
  };
  const output: EvaluatorOutput = {
    success: true,
    decision: "FINISH",
    thought: "Both requested outcomes have evidence.",
    messageToUser: "Created and checked the HTML file.",
    requestFullyCovered: true,
    outcomeCoverage: [
      {
        intentId: "intent:1",
        status: "completed",
        evidenceStepIds: ["step:1"],
      },
      {
        intentId: "intent:2",
        status: "completed",
        evidenceStepIds: ["step:2"],
      },
    ],
  };
  return { context, trajectory, output };
}

describe("auditable evaluator outcome coverage", () => {
  it("accepts all source-bound outcomes across archived and current steps without mutating evidence", () => {
    const value = fixture();
    const original = structuredClone(value);
    expect(validatedOutcomeCoverage(value)).toBe(true);
    expect(value).toEqual(original);
  });

  it.each([
    "missing",
    "duplicate",
    "invented",
    "blocked",
    "pending",
    "no evidence",
    "unknown evidence",
    "duplicate evidence",
  ])("rejects %s coverage", (kind) => {
    const value = fixture();
    if (!value.output.outcomeCoverage)
      throw new Error("Missing coverage fixture");
    const entries = structuredClone(value.output.outcomeCoverage);
    if (kind === "missing") value.output.outcomeCoverage = entries.slice(0, 1);
    else {
      const entry = {
        ...entries[1],
        evidenceStepIds: [...entries[1].evidenceStepIds],
      };
      if (kind === "duplicate") entry.intentId = "intent:1";
      if (kind === "invented") entry.intentId = "intent:99";
      if (kind === "blocked" || kind === "pending") entry.status = kind;
      if (kind === "no evidence") entry.evidenceStepIds = [];
      if (kind === "unknown evidence") entry.evidenceStepIds = ["step:99"];
      if (kind === "duplicate evidence")
        entry.evidenceStepIds = ["step:2", "step:2"];
      value.output.outcomeCoverage = [entries[0], entry];
    }
    expect(validatedOutcomeCoverage(value)).toBe(false);
  });

  it("requires a full-request judgment in addition to intent coverage", () => {
    const value = fixture();
    value.output.requestFullyCovered = false;
    expect(validatedOutcomeCoverage(value)).toBe(false);
    delete value.output.requestFullyCovered;
    expect(validatedOutcomeCoverage(value)).toBe(false);
  });

  it("cannot complete missing intents, pending calls, failures, or nonterminal decisions", () => {
    const absent = fixture();
    absent.context.events = [];
    expect(validatedOutcomeCoverage(absent)).toBe(false);
    const queued = fixture();
    queued.trajectory.plannedQueue.push({
      id: "verify",
      name: "BROWSER",
      params: {},
    });
    expect(validatedOutcomeCoverage(queued)).toBe(false);
    expect(
      validatedOutcomeCoverage({
        ...fixture(),
        hasUnresolvedToolFailure: true,
      }),
    ).toBe(false);
    for (const decision of ["CONTINUE", "NEXT_RECOMMENDED"] as const) {
      const value = fixture();
      value.output.decision = decision;
      expect(validatedOutcomeCoverage(value)).toBe(false);
    }
  });

  it("does not treat failed, missing, or terminal-only results as execution evidence", () => {
    for (const kind of ["failed", "missing", "terminal"] as const) {
      const value = fixture();
      if (kind === "failed")
        value.trajectory.steps[0].result = { success: false };
      if (kind === "missing") value.trajectory.steps[0].result = undefined;
      if (kind === "terminal") value.trajectory.steps[0].terminalOnly = true;
      expect(validatedOutcomeCoverage(value)).toBe(false);
    }
  });

  it("preserves original intent identity across a differently classified resumed request", async () => {
    const value = fixture();
    value.trajectory.outcomeIntents = [
      "create the HTML file",
      "read and verify the HTML file",
    ];
    value.trajectory.modelBaseContext = {
      id: "resumed-context",
      events: [
        {
          id: "fresh-handler",
          type: "message_handler",
          metadata: { plan: { intents: ["summarize the task"] } },
        },
      ],
    };
    let tail = "";
    await runEvaluator({
      ...value,
      runtime: {
        useModel: async (_type, options) => {
          tail = String(options.messages.at(-1)?.content ?? "");
          return JSON.stringify(value.output);
        },
      },
    });
    expect(tail).toContain("intent:1: create the HTML file");
    expect(tail).toContain("intent:2: read and verify the HTML file");
    expect(tail).not.toContain("intent:1: summarize the task");
    expect(validatedOutcomeCoverage(value)).toBe(true);
    value.output.outcomeCoverage = value.output.outcomeCoverage?.slice(0, 1);
    expect(validatedOutcomeCoverage(value)).toBe(false);
  });

  it("parses typed coverage and rejects malformed fields", () => {
    const valid = fixture().output;
    expect(parseEvaluatorOutput(JSON.stringify(valid)).outcomeCoverage).toEqual(
      valid.outcomeCoverage,
    );
    for (const invalid of [
      { requestFullyCovered: "yes" },
      {
        outcomeCoverage: [
          { intentId: "intent:1", status: "done", evidenceStepIds: ["step:1"] },
        ],
      },
      {
        outcomeCoverage: [
          {
            intentId: "intent:1",
            status: "completed",
            evidenceStepIds: ["step:1"],
            inventedProof: true,
          },
        ],
      },
    ]) {
      expect(
        parseEvaluatorOutput(JSON.stringify({ ...valid, ...invalid }))
          .protocolFailure,
      ).toBe(true);
    }
  });

  it("supplies original literals and distinct executed content for semantic verification", async () => {
    const value = fixture();
    const requested = "  user-owned token: alpha-37\r\nlast line  \n";
    const executed = requested.trimEnd();
    value.context.events.unshift({
      id: "original",
      type: "instruction",
      role: "user",
      content: `Save exactly:\n${requested}`,
    });
    value.trajectory.archivedSteps[0].toolCall.params = { content: executed };
    value.trajectory.steps[0].result = {
      success: true,
      text: executed,
      data: { sourceSha256: "integrity-hash-not-content" },
    };
    let messages: string[] = [];
    let system = "";
    await runEvaluator({
      ...value,
      runtime: {
        useModel: async (_type, options) => {
          messages = options.messages.map((message) =>
            typeof message.content === "string"
              ? message.content
              : JSON.stringify(message.content),
          );
          system = messages[0];
          return JSON.stringify({
            thought: "The saved content omits requested whitespace.",
            decision: "CONTINUE",
            success: false,
          });
        },
      },
    });
    expect(messages.some((content) => content.includes(requested))).toBe(true);
    expect(messages.join("\n")).toContain("integrity-hash-not-content");
    expect(system).toContain(
      "compare the original request with executed arguments and returned content",
    );
    expect(system).toContain(
      "including leading/trailing whitespace and final newlines",
    );
    const contentRule = system.indexOf(
      "For document extraction, verification codes",
    );
    expect(contentRule).toBeGreaterThanOrEqual(0);
    expect(contentRule).toBeLessThan(
      system.indexOf("Judge accumulated results"),
    );
    expect(system).toContain(
      "other identifiers are values in the document text, not file hashes",
    );
    expect(system).toContain(
      "only if the user explicitly asks for a hash, checksum or revision",
    );
    expect(system.match(/For document extraction/g)).toHaveLength(1);
    expect(value.trajectory.steps[0].result?.text).toBe(executed);
  });

  it("advertises source IDs after the original request and complete native evidence", async () => {
    const value = fixture();
    let wire = "";
    const output = await runEvaluator({
      ...value,
      runtime: {
        useModel: async (_type, options) => {
          wire = JSON.stringify(options.messages);
          return JSON.stringify(value.output);
        },
      },
    });
    expect(wire).toContain("intent:1: create the HTML file");
    expect(wire).toContain("step:1: WRITE; success=true");
    expect(wire).toContain("Written");
    expect(wire).toContain("step:2: READ; success=true");
    expect(wire.indexOf("# Current decision state")).toBeGreaterThan(
      wire.indexOf("Complete file contents"),
    );
    expect(validatedOutcomeCoverage({ ...value, output })).toBe(true);
  });
});
