/**
 * Fail-loud harness finalization (#9310):
 *  1. Unknown finalCheck types are a hard error at definition AND load time —
 *     a misspelled check type must never become a silently absent assertion.
 *  2. ScenarioTurn/ScenarioDefinition are closed types — a typo'd assertion
 *     key is a type error instead of an ignored no-op.
 *  3. A finalCheck whose runtime dependency is missing reports status
 *     `skipped`, which fails the scenario in the pr-deterministic lane.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { IAgentRuntime } from "@elizaos/core";
import {
  type ScenarioDefinition,
  type ScenarioFinalCheck,
  type ScenarioTurn,
  type ScenarioTurnExecution,
  scenario,
} from "@elizaos/scenario-runner/schema";
import { afterEach, describe, expect, it } from "vitest";
import {
  providerQualifiedScenarioProblems,
  skippedFinalCheckFailure,
} from "./executor.ts";
import { runFinalCheck } from "./final-checks/index.ts";
import { loadScenarioFile } from "./loader.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function makeTempScenarioDir(): Promise<string> {
  const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const dir = await mkdtemp(join(packageDir, ".tmp-schema-strict-"));
  tempDirs.push(dir);
  return dir;
}

describe("scenario() strict finalCheck validation", () => {
  const base = {
    id: "fixture.strict",
    title: "Strict fixture",
    domain: "fixture",
    turns: [{ kind: "message", name: "ask", text: "hello" }],
  } satisfies Omit<ScenarioDefinition, "finalChecks">;

  it("throws on an unknown finalCheck type instead of silently skipping it", () => {
    expect(() =>
      scenario({
        ...base,
        finalChecks: [
          // A typo'd discriminator used to pass validation untouched.
          { type: "definitionCountDeltaa", name: "typo" },
        ] as unknown as ScenarioFinalCheck[],
      }),
    ).toThrow(/unknown type "definitionCountDeltaa"/);
  });

  it("lists the known finalCheck types in the error", () => {
    expect(() =>
      scenario({
        ...base,
        finalChecks: [
          { type: "nope", name: "n" },
        ] as unknown as ScenarioFinalCheck[],
      }),
    ).toThrow(/Known types: .*judgeRubric.*definitionCountDelta/);
  });

  it("still accepts every known finalCheck type and rejects unknown fields", () => {
    expect(() =>
      scenario({
        ...base,
        finalChecks: [
          { type: "actionCalled", name: "ok", actionName: "CREATE_TASK" },
        ],
      }),
    ).not.toThrow();
    expect(() =>
      scenario({
        ...base,
        finalChecks: [
          {
            type: "actionCalled",
            name: "bad",
            actioName: "CREATE_TASK",
          },
        ] as unknown as ScenarioFinalCheck[],
      }),
    ).toThrow(/unknown field\(s\)/);
  });
});

describe("scenario() strict scenario metadata validation", () => {
  const base = {
    id: "fixture.strict.metadata",
    title: "Strict metadata fixture",
    domain: "fixture",
    turns: [{ kind: "message", name: "ask", text: "hello" }],
  } satisfies ScenarioDefinition;

  it("throws on an unknown top-level scenario status instead of running it", () => {
    expect(() =>
      scenario({
        ...base,
        status: "known-red",
      } as unknown as ScenarioDefinition),
    ).toThrow(/invalid status "known-red"/);
  });

  it("requires a concrete reason for pending scenarios", () => {
    expect(() => scenario({ ...base, status: "pending" })).toThrow(
      /pending without a concrete pendingReason/,
    );
    expect(() =>
      scenario({
        ...base,
        status: "pending",
        pendingReason: "Requires an authenticated provider fixture.",
      }),
    ).not.toThrow();
    expect(() =>
      scenario({
        ...base,
        status: "active",
        pendingReason: "This reason must not survive activation.",
      }),
    ).toThrow(/declares pendingReason but is not pending/);
  });
});

describe("loadScenarioFile strict validation", () => {
  it("hard-fails loading a plain-object scenario with an unknown finalCheck type", async () => {
    const dir = await makeTempScenarioDir();
    const file = join(dir, "bad-check.scenario.ts");
    await writeFile(
      file,
      [
        // A plain object export bypasses the scenario() helper, so the loader
        // must re-validate at load time.
        "export default {",
        '  id: "fixture.bad.check",',
        '  title: "Bad finalCheck",',
        '  domain: "fixture",',
        '  turns: [{ kind: "message", name: "ask", text: "hello" }],',
        '  finalChecks: [{ type: "memoryWriteOccured", name: "typo" }],',
        "};",
        "",
      ].join("\n"),
    );

    await expect(loadScenarioFile(file)).rejects.toThrow(
      /unknown type "memoryWriteOccured"/,
    );
  });

  it("loads a valid plain-object scenario unchanged", async () => {
    const dir = await makeTempScenarioDir();
    const file = join(dir, "good.scenario.ts");
    await writeFile(
      file,
      [
        "export default {",
        '  id: "fixture.good",',
        '  title: "Good",',
        '  domain: "fixture",',
        '  turns: [{ kind: "message", name: "ask", text: "hello" }],',
        '  finalChecks: [{ type: "gmailNoRealWrite", name: "no writes" }],',
        "};",
        "",
      ].join("\n"),
    );

    await expect(loadScenarioFile(file)).resolves.toMatchObject({
      scenario: { id: "fixture.good" },
    });
  });
});

describe("skipped finalChecks (dependency missing)", () => {
  const runtime = {} as IAgentRuntime;

  it("reports status 'skipped' when the approval queue dependency is missing", async () => {
    const result = await runFinalCheck(
      { type: "approvalRequestExists", name: "approval" },
      { runtime, ctx: { actionsCalled: [] } },
    );
    expect(result).toMatchObject({
      status: "skipped",
      detail: "dependency missing: no approval queue service registered",
    });
  });

  it("reports status 'skipped' when the connector dispatcher dependency is missing", async () => {
    const result = await runFinalCheck(
      { type: "pushSent", name: "push", channel: "telegram" },
      { runtime, ctx: { actionsCalled: [] } },
    );
    expect(result).toMatchObject({
      status: "skipped",
      detail: "dependency missing: no connector dispatcher registered",
    });
  });

  it("fails the scenario for a skipped check in the pr-deterministic lane", () => {
    const failure = skippedFinalCheckFailure("pr-deterministic", {
      status: "skipped",
      label: "approval",
      detail: "dependency missing: no approval queue service registered",
    });
    expect(failure).toMatch(/failure in the pr-deterministic lane/);
    expect(failure).toContain('finalCheck "approval" skipped');
  });

  it("does not fail live-only scenarios for skips (they are counted instead)", () => {
    expect(
      skippedFinalCheckFailure("live-only", {
        status: "skipped",
        label: "approval",
        detail: "dependency missing: no approval queue service registered",
      }),
    ).toBeNull();
    expect(
      skippedFinalCheckFailure("pr-deterministic", {
        status: "passed",
        label: "approval",
        detail: "1 matching approval request(s)",
      }),
    ).toBeNull();
  });

  it("fails a provider-qualified run when any trusted check is skipped", () => {
    expect(
      skippedFinalCheckFailure(
        "live-only",
        {
          status: "skipped",
          label: "provider readback",
          detail: "trusted observer evidence is unavailable",
        },
        "provider-qualified",
      ),
    ).toContain("failure in provider-qualified execution");
  });
});

describe("binding connector evidence", () => {
  const runtime = {} as IAgentRuntime;
  const inferredDispatch = {
    channel: "sms",
    delivered: false,
    evidenceSource: "action-result-inference" as const,
    status: "reported_success" as const,
  };

  it("does not treat an action success report as a connector dispatch", async () => {
    const result = await runFinalCheck(
      { type: "connectorDispatchOccurred", name: "dispatch", channel: "sms" },
      {
        runtime,
        ctx: { actionsCalled: [], connectorDispatches: [inferredDispatch] },
      },
    );
    expect(result).toMatchObject({ status: "failed" });
  });

  it("does not treat action result prose/status as message delivery", async () => {
    const result = await runFinalCheck(
      { type: "messageDelivered", name: "delivery", channel: "sms" },
      {
        runtime,
        ctx: {
          actionsCalled: [
            {
              actionName: "MESSAGE",
              result: {
                success: true,
                data: { channel: "sms", status: "delivered" },
              },
            },
          ],
          connectorDispatches: [inferredDispatch],
        },
      },
    );
    expect(result).toMatchObject({ status: "failed" });
  });

  it("scopes dispatch absence and exact counts to named turns", async () => {
    const observed = {
      channel: "sms",
      delivered: true,
      evidenceSource: "runtime-send-handler" as const,
      status: "delivered" as const,
      providerMessageIds: ["SM42"],
      idempotencyKey: "approval-42",
    };
    const ctx = {
      actionsCalled: [],
      connectorDispatches: [observed],
      turns: [
        {
          name: "draft",
          actionsCalled: [],
          connectorDispatches: [],
        },
        {
          name: "confirm",
          actionsCalled: [],
          connectorDispatches: [observed],
        },
      ],
    };
    await expect(
      runFinalCheck(
        {
          type: "connectorDispatchOccurred",
          name: "no pre-confirm send",
          channel: "sms",
          turn: "draft",
          expected: false,
        },
        { runtime, ctx },
      ),
    ).resolves.toMatchObject({ status: "passed" });
    await expect(
      runFinalCheck(
        {
          type: "connectorDispatchOccurred",
          name: "one confirmed send",
          channel: "sms",
          turn: "confirm",
          minCount: 1,
          maxCount: 1,
          delivered: true,
          status: "delivered",
          idempotencyKey: "approval-42",
          providerMessageId: "SM42",
        },
        { runtime, ctx },
      ),
    ).resolves.toMatchObject({ status: "passed" });
  });

  it("fails noSideEffects on authoritative turn-scoped effects", async () => {
    const result = await runFinalCheck(
      { type: "noSideEffects", name: "read-only", turn: "question" },
      {
        runtime,
        ctx: {
          actionsCalled: [],
          turns: [
            {
              name: "question",
              actionsCalled: [],
              connectorDispatches: [],
              stateTransitions: [
                { subject: "todo:42", from: "open", to: "deleted" },
              ],
            },
          ],
        },
      },
    );
    expect(result).toMatchObject({ status: "failed" });
  });

  it("can treat approval creation as a safe continuation without allowing dispatch", async () => {
    const result = await runFinalCheck(
      {
        type: "noSideEffects",
        name: "approval only",
        turn: "proposal",
        allowApprovalRequests: true,
      },
      {
        runtime,
        ctx: {
          actionsCalled: [],
          turns: [
            {
              name: "proposal",
              actionsCalled: [],
              connectorDispatches: [],
              approvalRequests: [
                { id: "approval-42", actionName: "MESSAGE", state: "pending" },
              ],
            },
          ],
        },
      },
    );
    expect(result).toMatchObject({ status: "passed" });
  });
});

describe("turn-scoped Gmail fixture evidence", () => {
  const runtime = {} as IAgentRuntime;
  const exactWrite = {
    provider: "gmail",
    method: "POST",
    path: "/gmail/v1/users/me/messages/batchModify",
    body: {
      ids: ["msg-a", "msg-b"],
      removeLabelIds: ["INBOX"],
    },
    metadata: {
      action: "messages.batchModify",
      ids: ["msg-a", "msg-b"],
    },
  };

  it("binds an exact Gmail ID set to the named turn", async () => {
    const result = await runFinalCheck(
      {
        type: "gmailMockRequest",
        name: "exact bulk archive",
        method: "POST",
        path: "/gmail/v1/users/me/messages/batchModify",
        body: { ids: ["msg-a", "msg-b"], removeLabelIds: ["INBOX"] },
        gmail: { action: "messages.batchModify", ids: ["msg-a", "msg-b"] },
        exactArrays: true,
        turn: "confirm",
        minCount: 1,
        maxCount: 1,
      },
      {
        runtime,
        ctx: {
          actionsCalled: [],
          turns: [
            { name: "review", actionsCalled: [], providerRequests: [] },
            {
              name: "confirm",
              actionsCalled: [],
              providerRequests: [exactWrite],
            },
          ],
        },
      },
    );
    expect(result).toMatchObject({ status: "passed" });
  });

  it("rejects an extra Gmail target under exact-array matching", async () => {
    const result = await runFinalCheck(
      {
        type: "gmailMockRequest",
        name: "no decoy mutation",
        method: "POST",
        path: "/gmail/v1/users/me/messages/batchModify",
        body: { ids: ["msg-a"] },
        exactArrays: true,
        turn: "confirm",
      },
      {
        runtime,
        ctx: {
          actionsCalled: [],
          turns: [
            {
              name: "confirm",
              actionsCalled: [],
              providerRequests: [exactWrite],
            },
          ],
        },
      },
    );
    expect(result).toMatchObject({ status: "failed" });
  });

  it("fails closed when turn-scoped Gmail request evidence is unavailable", async () => {
    const result = await runFinalCheck(
      {
        type: "gmailMockRequest",
        name: "prove no write",
        method: "POST",
        expected: false,
        turn: "review",
      },
      {
        runtime,
        ctx: {
          actionsCalled: [],
          turns: [{ name: "review", actionsCalled: [] }],
        },
      },
    );
    expect(result).toMatchObject({
      status: "failed",
      detail: expect.stringContaining("ledger unavailable"),
    });
  });
});

describe("provider-qualified data boundary", () => {
  const trustedScenario = {
    id: "fixture.provider-qualified",
    title: "Provider-qualified fixture",
    domain: "fixture",
    lane: "live-only",
    executionProfile: "provider-qualified",
    evidenceScope: "provider-certification",
    isolation: "per-scenario",
    requires: { plugins: ["@elizaos/plugin-personal-assistant"] },
    turns: [
      {
        kind: "message",
        name: "ask",
        text: "Create the approved event.",
        responseJudge: {
          rubric: "The response reports only evidence-backed outcomes.",
        },
      },
    ],
    finalChecks: [
      {
        type: "providerEffectObserved",
        name: "provider readback",
        provider: "google-calendar",
        operation: "create",
      },
      {
        type: "judgeRubric",
        name: "semantic quality",
        rubric: "The response is precise and truthful.",
      },
    ],
  } satisfies ScenarioDefinition;

  it("accepts only isolated message-and-observer definitions", () => {
    expect(providerQualifiedScenarioProblems(trustedScenario)).toEqual([]);
  });

  it("rejects executable harness paths and simulated state", () => {
    const unsafe = {
      ...trustedScenario,
      isolation: "shared-runtime",
      rooms: [{ id: "forged-owner", account: "admin" }],
      mockoon: ["google"],
      seed: [{ type: "advanceClock", by: "PT1H" }],
      cleanup: [{ type: "gmailDeleteDrafts" }],
      turns: [
        {
          kind: "api",
          name: "bypass",
          path: "/api/lifeops/calendar",
          assertResponse: () => undefined,
        },
      ],
      finalChecks: [
        {
          type: "custom",
          name: "self asserted",
          predicate: () => undefined,
        },
      ],
    } as unknown as ScenarioDefinition;

    const problems = providerQualifiedScenarioProblems(unsafe).join("\n");
    expect(problems).toContain("seed steps");
    expect(problems).toContain("isolation=per-scenario");
    expect(problems).toContain("Mockoon");
    expect(problems).toContain("operator-signed run manifest");
    expect(problems).toContain("only explicit message turns");
    expect(problems).toContain("data-only ingress contract");
    expect(problems).toContain("external operator");
    expect(problems).toContain("trusted-observer checks");
  });
});

describe("closed scenario types (typo-prone keys are type errors)", () => {
  it("rejects typo'd turn assertion keys and dead planner fields at compile time", () => {
    // @ts-expect-error acceptedActions is not a real turn key (use expectedActions)
    const typoTurn: ScenarioTurn = { name: "t", acceptedActions: ["X"] };
    const plannerJudgeTurn: ScenarioTurn = {
      name: "t",
      // @ts-expect-error plannerJudge was declared but never consumed by the executor — removed
      plannerJudge: { rubric: "r" },
    };
    const execution: ScenarioTurnExecution = {
      actionsCalled: [],
      // @ts-expect-error plannerText was never assigned by the executor — removed
      plannerText: "never populated",
    };
    const typoScenario: ScenarioDefinition = {
      id: "x",
      title: "x",
      domain: "x",
      turns: [],
      // @ts-expect-error unknown top-level scenario keys are type errors
      finalCheks: [],
    };
    // The values only exist so the compile-time assertions above have a home.
    expect([typoTurn, plannerJudgeTurn, execution, typoScenario]).toBeTruthy();
  });
});
