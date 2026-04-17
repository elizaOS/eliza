/**
 * Executes one scenario end-to-end against a live runtime:
 *   1. Check `requires` gates — skip with reason if a required plugin/credential
 *      isn't available.
 *   2. Run seed steps (currently only `custom` is universal; others are noted
 *      as skipped-dependency-missing so the runner degrades gracefully without
 *      silently passing).
 *   3. For each turn: send the user message through messageService, capture
 *      response text and actions, run per-turn `assertResponse` / `assertTurn`
 *      / `responseJudge`.
 *   4. Run `finalChecks` via the handler registry.
 *   5. Aggregate + return a ScenarioReport.
 */

import crypto from "node:crypto";
import type { AgentRuntime, Memory, UUID } from "@elizaos/core";
import {
  ChannelType,
  createMessageMemory,
  logger,
  stringToUuid,
} from "@elizaos/core";
import type {
  ScenarioContext,
  ScenarioDefinition,
  ScenarioFinalCheck,
  ScenarioJudgeRubric,
  ScenarioTurn,
  ScenarioTurnExecution,
} from "@elizaos/scenario-schema";
import { runFinalCheck } from "./final-checks/index.ts";
import { attachInterceptor } from "./interceptor.ts";
import { judgeTextWithLlm } from "./judge.ts";
import type {
  FinalCheckReport,
  RunnerContext,
  ScenarioReport,
  TurnReport,
} from "./types.ts";

export interface ExecutorOptions {
  providerName: string;
  minJudgeScore: number;
  turnTimeoutMs: number;
}

const DEFAULT_TURN_TIMEOUT_MS = 120_000;

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function resolveRequiredPlugins(scenario: ScenarioDefinition): string[] {
  const requires = (scenario as { requires?: { plugins?: unknown } }).requires;
  const plugins = requires?.plugins;
  if (!Array.isArray(plugins)) return [];
  return plugins.filter((p): p is string => typeof p === "string");
}

function pluginIsRegistered(runtime: AgentRuntime, name: string): boolean {
  const plugins = (runtime as { plugins?: Array<{ name?: unknown }> }).plugins ?? [];
  const normalized = name.replace(/^@elizaos\/plugin-/, "");
  return plugins.some((p) => {
    const pn = typeof p.name === "string" ? p.name : "";
    return pn === name || pn === normalized;
  });
}

async function runCustomSeeds(
  scenario: ScenarioDefinition,
  runtime: AgentRuntime,
  ctx: RunnerContext,
): Promise<string | undefined> {
  const seeds = (scenario as { seed?: unknown }).seed;
  if (!Array.isArray(seeds)) return undefined;
  const scenarioCtx: ScenarioContext = { ...ctx, runtime };
  for (const seed of seeds) {
    if (seed === null || typeof seed !== "object") continue;
    const { type, name, apply } = seed as {
      type?: unknown;
      name?: unknown;
      apply?: unknown;
    };
    if (type !== "custom") continue;
    if (typeof apply !== "function") continue;
    try {
      const result = await (apply as (c: ScenarioContext) => unknown)(
        scenarioCtx,
      );
      if (typeof result === "string" && result.length > 0) {
        return `seed ${name ?? "(unnamed)"}: ${result}`;
      }
    } catch (err) {
      return `seed ${name ?? "(unnamed)"} threw: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  return undefined;
}

async function executeMessageTurn(
  runtime: AgentRuntime,
  turn: ScenarioTurn,
  roomId: UUID,
  userId: UUID,
): Promise<{ responseText: string; durationMs: number }> {
  const text = typeof turn.text === "string" ? turn.text : "";
  if (text.length === 0) {
    throw new Error(`[executor] turn '${turn.name}' has no text to send`);
  }

  const message: Memory = createMessageMemory({
    id: crypto.randomUUID() as UUID,
    entityId: userId,
    roomId,
    content: {
      text,
      source: "scenario-runner",
      channelType: ChannelType.DM,
    },
  });

  const messageService = (runtime as {
    messageService?: {
      handleMessage: (
        rt: AgentRuntime,
        memory: Memory,
        cb: (content: { text?: string }) => Promise<unknown>,
        options?: Record<string, unknown>,
      ) => Promise<{
        responseContent?: { text?: string };
        responseMessages?: Memory[];
      }>;
    };
  }).messageService;
  if (!messageService) {
    throw new Error(
      "[executor] runtime.messageService is not initialized — cannot send messages",
    );
  }

  const startedAt = Date.now();
  let responseText = "";
  const callback = async (content: { text?: string }): Promise<unknown[]> => {
    if (content.text) responseText += content.text;
    return [];
  };
  const timeoutMs =
    typeof turn.timeoutMs === "number" ? turn.timeoutMs : DEFAULT_TURN_TIMEOUT_MS;

  const result = await withTimeout(
    messageService.handleMessage(runtime, message, callback, {}),
    timeoutMs,
    `handleMessage(${turn.name})`,
  );

  if (!responseText && result?.responseContent?.text) {
    responseText = result.responseContent.text;
  }

  // Let completed events settle.
  await new Promise((r) => setTimeout(r, 500));

  return { responseText, durationMs: Date.now() - startedAt };
}

async function runTurnAssertions(
  turn: ScenarioTurn,
  execution: ScenarioTurnExecution,
  runtime: AgentRuntime,
  minJudgeScore: number,
): Promise<string[]> {
  const failures: string[] = [];

  if (typeof turn.assertResponse === "function") {
    const fn = turn.assertResponse as (text: string) => unknown;
    const result = await fn(execution.responseText ?? "");
    if (typeof result === "string" && result.length > 0) {
      failures.push(`assertResponse: ${result}`);
    }
  }

  if (typeof turn.assertTurn === "function") {
    const result = await turn.assertTurn(execution);
    if (typeof result === "string" && result.length > 0) {
      failures.push(`assertTurn: ${result}`);
    }
  }

  // responseIncludesAny / forbiddenActions / responseIncludesAll (inline)
  const includesAny = (turn as { responseIncludesAny?: unknown })
    .responseIncludesAny;
  if (Array.isArray(includesAny) && includesAny.length > 0) {
    const text = (execution.responseText ?? "").toLowerCase();
    const ok = includesAny.some(
      (p) => typeof p === "string" && text.includes(p.toLowerCase()),
    );
    if (!ok) {
      failures.push(
        `responseIncludesAny: response missing any of [${includesAny.join(",")}]`,
      );
    }
  }
  const forbidden = (turn as { forbiddenActions?: unknown }).forbiddenActions;
  if (Array.isArray(forbidden) && forbidden.length > 0) {
    const hits = execution.actionsCalled.filter((a) =>
      forbidden.includes(a.actionName),
    );
    if (hits.length > 0) {
      failures.push(
        `forbiddenActions triggered: ${hits.map((h) => h.actionName).join(",")}`,
      );
    }
  }

  if (turn.responseJudge) {
    const rubric = turn.responseJudge as ScenarioJudgeRubric;
    const threshold = rubric.minimumScore ?? minJudgeScore;
    try {
      const judged = await judgeTextWithLlm(
        runtime,
        execution.responseText ?? "",
        rubric.rubric,
      );
      if (judged.score < threshold) {
        failures.push(
          `responseJudge: score ${judged.score.toFixed(2)} < ${threshold}: ${judged.reason}`,
        );
      }
    } catch (err) {
      failures.push(
        `responseJudge: judge failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return failures;
}

async function runJudgeRubricFinalCheck(
  check: ScenarioFinalCheck,
  runtime: AgentRuntime,
  ctx: RunnerContext,
  minJudgeScore: number,
): Promise<FinalCheckReport> {
  const { name, rubric, minimumScore } = check as {
    name?: string;
    rubric?: string;
    minimumScore?: number;
  };
  const threshold = minimumScore ?? minJudgeScore;
  const lastTurn = ctx.turns[ctx.turns.length - 1];
  const candidate = lastTurn?.responseText ?? "";
  if (typeof rubric !== "string" || rubric.length === 0) {
    return {
      label: name ?? "judgeRubric",
      type: "judgeRubric",
      status: "failed",
      detail: "judgeRubric final check missing rubric string",
    };
  }
  try {
    const judged = await judgeTextWithLlm(runtime, candidate, rubric);
    if (judged.score < threshold) {
      return {
        label: name ?? "judgeRubric",
        type: "judgeRubric",
        status: "failed",
        detail: `score ${judged.score.toFixed(2)} < ${threshold}: ${judged.reason}`,
      };
    }
    return {
      label: name ?? "judgeRubric",
      type: "judgeRubric",
      status: "passed",
      detail: `score ${judged.score.toFixed(2)} ≥ ${threshold}`,
    };
  } catch (err) {
    return {
      label: name ?? "judgeRubric",
      type: "judgeRubric",
      status: "failed",
      detail: `judge failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export async function runScenario(
  scenario: ScenarioDefinition,
  runtime: AgentRuntime,
  opts: ExecutorOptions,
): Promise<ScenarioReport> {
  const startedAt = Date.now();
  const ctx: RunnerContext = {
    actionsCalled: [],
    turns: [],
    approvalRequests: [],
    connectorDispatches: [],
    memoryWrites: [],
    stateTransitions: [],
  };

  const report: ScenarioReport = {
    id: scenario.id,
    title: scenario.title,
    domain: scenario.domain,
    tags: Array.isArray((scenario as unknown as { tags?: unknown }).tags)
      ? (((scenario as unknown as { tags: unknown[] }).tags).filter(
          (t): t is string => typeof t === "string",
        ) as readonly string[])
      : [],
    status: "passed",
    durationMs: 0,
    turns: [],
    finalChecks: [],
    actionsCalled: [],
    failedAssertions: [],
    providerName: opts.providerName,
  };

  // Requires gate
  const requiredPlugins = resolveRequiredPlugins(scenario);
  const missing = requiredPlugins.filter((p) => !pluginIsRegistered(runtime, p));
  if (missing.length > 0) {
    report.status = "skipped";
    report.skipReason = `required plugin(s) not registered: ${missing.join(",")}`;
    report.durationMs = Date.now() - startedAt;
    return report;
  }

  const interceptor = attachInterceptor(runtime);
  const roomId = crypto.randomUUID() as UUID;
  const userId = crypto.randomUUID() as UUID;
  const worldId = stringToUuid("scenario-runner-world");

  try {
    await runtime.ensureConnection({
      entityId: userId,
      roomId,
      worldId,
      userName: "ScenarioUser",
      source: "scenario-runner",
      channelId: roomId,
      type: ChannelType.DM,
    });

    const seedErr = await runCustomSeeds(scenario, runtime, ctx);
    if (seedErr) {
      report.status = "failed";
      report.error = seedErr;
      report.durationMs = Date.now() - startedAt;
      return report;
    }

    for (const turn of scenario.turns) {
      const kind = typeof turn.kind === "string" ? turn.kind : "message";
      if (kind !== "message") {
        report.turns.push({
          name: turn.name,
          kind,
          text: typeof turn.text === "string" ? turn.text : undefined,
          responseText: "",
          actionsCalled: [],
          durationMs: 0,
          failedAssertions: [
            `turn kind '${kind}' is not supported by this runner (only 'message' is implemented)`,
          ],
        });
        report.status = "failed";
        continue;
      }

      const actionsBefore = interceptor.actions.length;
      const { responseText, durationMs } = await executeMessageTurn(
        runtime,
        turn,
        roomId,
        userId,
      );
      const actionsThisTurn = interceptor.actions.slice(actionsBefore);
      const execution: ScenarioTurnExecution = {
        actionsCalled: actionsThisTurn,
        responseText,
      };
      ctx.turns.push(execution);

      const failedAssertions = await runTurnAssertions(
        turn,
        execution,
        runtime,
        opts.minJudgeScore,
      );
      report.turns.push({
        name: turn.name,
        kind,
        text: typeof turn.text === "string" ? turn.text : undefined,
        responseText,
        actionsCalled: actionsThisTurn,
        durationMs,
        failedAssertions,
      });
      if (failedAssertions.length > 0) {
        report.status = "failed";
        for (const detail of failedAssertions) {
          report.failedAssertions.push({ label: turn.name, detail });
        }
      }
    }

    ctx.actionsCalled = interceptor.actions;
    ctx.memoryWrites = interceptor.memoryWrites;
    report.actionsCalled = [...interceptor.actions];

    const finalChecks = Array.isArray(
      (scenario as { finalChecks?: unknown }).finalChecks,
    )
      ? ((scenario as { finalChecks: ScenarioFinalCheck[] }).finalChecks ?? [])
      : [];
    for (const check of finalChecks) {
      const type = (check as { type?: string }).type ?? "unknown";
      let result: FinalCheckReport;
      if (type === "judgeRubric") {
        result = await runJudgeRubricFinalCheck(
          check,
          runtime,
          ctx,
          opts.minJudgeScore,
        );
      } else {
        result = await runFinalCheck(check, { runtime, ctx });
      }
      report.finalChecks.push(result);
      if (result.status === "failed") {
        report.status = "failed";
        report.failedAssertions.push({
          label: result.label,
          detail: result.detail,
        });
      }
    }
  } catch (err) {
    report.status = "failed";
    report.error = err instanceof Error ? err.message : String(err);
    logger.warn(
      `[scenario-runner] ${scenario.id} threw: ${report.error}`,
    );
  } finally {
    interceptor.detach();
    report.durationMs = Date.now() - startedAt;
  }

  return report;
}
