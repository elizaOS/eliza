import { describe, expect, test } from "vitest";
import type { Content, Memory } from "@elizaos/core";
import { subscriptionsAction } from "../src/actions/subscriptions.js";
import { LifeOpsRepository } from "../src/lifeops/repository.js";
import { createLifeOpsChatTestRuntime } from "./helpers/lifeops-chat-runtime.js";
import { runScenario } from "../../../packages/scenario-runner/src/executor.ts";
import cancelGooglePlayScenario from "../../../../test/scenarios/browser.lifeops/subscriptions.cancel-google-play.scenario";
import loginRequiredScenario from "../../../../test/scenarios/browser.lifeops/subscriptions.login-required.scenario";

async function createScenarioRuntime(agentId: string) {
  const runtime = createLifeOpsChatTestRuntime({
    agentId,
    actions: [subscriptionsAction],
    useModel: async () => {
      throw new Error("scenario tests should not invoke useModel");
    },
    handleTurn: async ({ message, onResponse, runtime, state }) => {
      const result = await subscriptionsAction.handler(runtime, message as Memory, state, {
        parameters: {},
      });
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

describe("LifeOps subscription browser scenarios", () => {
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
