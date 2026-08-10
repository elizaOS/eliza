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
        '  finalChecks: [{ type: "mcpToolCall", tool: "create_draft", expected: false }],',
        "};",
        "",
      ].join("\n"),
    );

    await expect(loadScenarioFile(file)).resolves.toMatchObject({
      scenario: { id: "fixture.good" },
    });
  });
});

describe("MCP fixture ledger checks", () => {
  const runtime = {} as IAgentRuntime;
  const ctx = {
    actionsCalled: [],
    mcpToolCalls: [
      {
        provider: "google",
        resource: "gmail",
        tool: "search_threads",
        accountId: "google-personal",
        requiredCapability: "gmail.read",
        authorization: "authorized" as const,
        arguments: {
          query: "is:unread",
          pageSize: 20,
          view: "THREAD_VIEW_MINIMAL",
        },
        result: {
          content: [],
          structuredContent: { threads: [{ id: "thread-1" }] },
        },
        calledAt: "2026-08-10T12:00:00.000Z",
      },
      {
        provider: "google",
        resource: "gmail",
        tool: "get_message",
        accountId: "google-personal",
        requiredCapability: "gmail.read",
        authorization: "authorized" as const,
        arguments: { messageId: "msg-1", messageFormat: "FULL_CONTENT" },
        result: {
          content: [],
          structuredContent: { message: { id: "msg-1" } },
        },
        calledAt: "2026-08-10T12:00:01.000Z",
      },
    ],
  };

  it("matches canonical call arguments, result, account, and capability", async () => {
    await expect(
      runFinalCheck(
        {
          type: "mcpToolCall",
          provider: "google",
          resource: "gmail",
          tool: "search_threads",
          accountId: "google-personal",
          requiredCapability: "gmail.read",
          arguments: { query: "is:unread" },
          result: { "structuredContent.threads": [{ id: "thread-1" }] },
        },
        { runtime, ctx },
      ),
    ).resolves.toMatchObject({ status: "passed" });
  });

  it("checks ordered and exact call sequences", async () => {
    await expect(
      runFinalCheck(
        {
          type: "mcpToolCalls",
          provider: "google",
          resource: "gmail",
          exact: true,
          calls: [
            { tool: "search_threads", arguments: { query: "is:unread" } },
            { tool: "get_message", arguments: { messageId: "msg-1" } },
          ],
        },
        { runtime, ctx },
      ),
    ).resolves.toMatchObject({ status: "passed" });
  });

  it("rejects the removed REST-shaped Gmail request check", () => {
    expect(() =>
      scenario({
        id: "fixture.removed.gmail-rest-check",
        title: "Removed Gmail REST check",
        domain: "fixture",
        turns: [],
        finalChecks: [
          {
            type: "gmailMockRequest",
            method: "GET",
            path: "/gmail/v1/users/me/messages",
          },
        ] as unknown as ScenarioFinalCheck[],
      }),
    ).toThrow(/unknown type "gmailMockRequest"/);
  });

  it.each([
    "gmailDraftCreated",
    "gmailDraftDeleted",
    "gmailMessageSent",
    "gmailBatchModify",
    "gmailApproval",
    "gmailNoRealWrite",
  ])("rejects removed Gmail compatibility check %s", (type) => {
    expect(() =>
      scenario({
        id: `fixture.removed.${type}`,
        title: "Removed Gmail compatibility check",
        domain: "fixture",
        turns: [],
        finalChecks: [{ type }] as unknown as ScenarioFinalCheck[],
      }),
    ).toThrow(`unknown type "${type}"`);
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

describe("provider-qualified data boundary", () => {
  const trustedScenario = {
    id: "fixture.provider-qualified",
    title: "Provider-qualified fixture",
    domain: "fixture",
    lane: "live-only",
    executionProfile: "provider-qualified",
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
      cleanup: [{ type: "selfControlClearBlocks", profile: "fixture" }],
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
