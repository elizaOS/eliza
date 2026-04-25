/**
 * FIXTURE ROUTING REGRESSION TEST (not a behavioral scenario test).
 *
 * `resolveSubscriptionParams` is an in-file regex router that maps
 * known test-input phrases to action parameters. The LLM (`useModel`)
 * is intentionally disabled; this file verifies only that the fixture
 * router + the downstream SUBSCRIPTIONS action produce the expected
 * `ActionResult` shape for the hardcoded inputs. Do NOT read a passing
 * run of this file as evidence that the LLM planner or the
 * subscriptions action handle novel/unseen user phrasings.
 */
import { describe, expect, test } from "vitest";
import type { Content, Memory } from "@elizaos/core";
import { subscriptionsAction } from "../src/actions/subscriptions.js";
import { LifeOpsRepository } from "../src/lifeops/repository.js";
import { createLifeOpsChatTestRuntime } from "./helpers/lifeops-chat-runtime.js";
import { runScenario } from "../../../packages/scenario-runner/src/executor.ts";
import cancelGooglePlayScenario from "../../../../test/scenarios/browser.lifeops/subscriptions.cancel-google-play.scenario";
import loginRequiredScenario from "../../../../test/scenarios/browser.lifeops/subscriptions.login-required.scenario";

function buildSubscriptionsPlannerStub() {
  return async (_modelType: unknown, input: { prompt?: string } | string) => {
    const prompt =
      typeof input === "string"
        ? input
        : typeof input?.prompt === "string"
          ? input.prompt
          : "";
    const requestMatch = prompt.match(/Current request:\s*(".*")/);
    const request = requestMatch ? JSON.parse(requestMatch[1]) : "";
    const normalized = String(request).toLowerCase();
    const serviceName = normalized.includes("google play")
      ? "Google Play"
      : normalized.includes("fixture access wall")
        ? "Fixture Access Wall"
        : null;
    const serviceSlug =
      serviceName === null
        ? null
        : serviceName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const plan = {
      mode: "cancel",
      serviceName,
      serviceSlug,
      executor: "agent_browser",
      queryWindowDays: null,
      confirmed:
        normalized.includes("confirm") || normalized.includes("go ahead"),
      shouldAct: true,
      response: null,
    };
    return JSON.stringify(plan);
  };
}

function resolveSubscriptionParams(text: string) {
  const normalized = text.toLowerCase();
  const serviceName = normalized.includes("google play")
    ? "Google Play"
    : normalized.includes("fixture login required")
      ? "Fixture Login Required"
      : "Fixture Access Wall";
  const serviceSlug = serviceName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return {
    mode: "cancel",
    serviceName,
    serviceSlug,
    confirmed:
      normalized.includes("confirm") || normalized.includes("go ahead"),
  };
}

async function createScenarioRuntime(agentId: string) {
  const runtime = createLifeOpsChatTestRuntime({
    agentId,
    actions: [subscriptionsAction],
    useModel: buildSubscriptionsPlannerStub(),
    handleTurn: async ({ message, onResponse, runtime, state }) => {
      const text =
        (message.content as { text?: string } | undefined)?.text ?? "";
      const result = await subscriptionsAction.handler(
        runtime,
        message as Memory,
        state,
        { parameters: resolveSubscriptionParams(text) },
      );
      const content: Content & Record<string, unknown> = {
        text: result.text ?? "",
        actions: [subscriptionsAction.name],
        ...(result.data && typeof result.data === "object"
          ? { data: result.data, ...result.data }
          : {}),
      };
      await onResponse(content);
      return {
        text: result.text ?? "",
        actions: [subscriptionsAction.name],
        data:
          result.data && typeof result.data === "object"
            ? (result.data as Record<string, unknown>)
            : undefined,
      };
    },
  });
  await LifeOpsRepository.bootstrapSchema(runtime);
  return runtime;
}

describe("subscriptions — fixture routing regression test (regex param extraction)", () => {
  test("google play happy-path scenario passes", async () => {
    const runtime = await createScenarioRuntime("lifeops-subscriptions-scenario-ok");
    const report = await runScenario(cancelGooglePlayScenario, runtime, {
      providerName: "test",
      minJudgeScore: 0.7,
      turnTimeoutMs: 20_000,
    });
    expect(report.status).toBe("passed");
    expect(
      report.finalChecks.every((check) => check.status === "passed"),
    ).toBe(true);
  });

  test("login-required scenario passes with human-handoff final checks", async () => {
    const runtime = await createScenarioRuntime(
      "lifeops-subscriptions-scenario-login",
    );
    const report = await runScenario(loginRequiredScenario, runtime, {
      providerName: "test",
      minJudgeScore: 0.7,
      turnTimeoutMs: 20_000,
    });
    expect(report.status).toBe("passed");
    expect(
      report.finalChecks.every((check) => check.status === "passed"),
    ).toBe(true);
  });
});
