/**
 * browser-portal — fixture routing regression test (handleTurn string-match)
 *
 * This is NOT a scenario test of the LifeOps planner. It only verifies that
 * the browser-portal FIXTURE's canned string-match routing produces the
 * expected action-result shape for the exact inputs hardcoded into the
 * fixture.
 *
 * The fixture (see `./helpers/browser-portal-scenario-fixture.ts`) hard-bans
 * `useModel` and implements `handleTurn` as a lowercased regex cascade over
 * the incoming message text, returning pre-built action results. No planner,
 * no LLM, no routing logic under test — just a guard that the fixture keeps
 * answering these specific prompts with these specific action shapes so
 * downstream scenario-runner plumbing (judges, final checks) stays wired.
 *
 * If you are looking for end-to-end planner coverage for the browser/portal
 * flows, this file is not it.
 */
import { describe, expect, test } from "vitest";
import { runScenario } from "../../../packages/scenario-runner/src/executor.ts";
import collectIdCopyScenario from "../../../../test/scenarios/executive-assistant/ea.docs.collect-id-copy-for-workflow.scenario";
import portalUploadScenario from "../../../../test/scenarios/executive-assistant/ea.docs.portal-upload-from-chat.scenario";
import browserPortalConnectorScenario from "../../../../test/scenarios/connector-certification/connector.browser-portal.certify-core.scenario";
import { createBrowserPortalScenarioRuntime } from "./helpers/browser-portal-scenario-fixture.js";

async function expectScenarioPasses(
  scenarioDefinition: Parameters<typeof runScenario>[0],
  agentId: string,
) {
  const runtime = await createBrowserPortalScenarioRuntime(agentId);
  const report = await runScenario(scenarioDefinition, runtime, {
    providerName: "test",
    minJudgeScore: 0.7,
    turnTimeoutMs: 20_000,
  });
  expect(report.status, JSON.stringify(report, null, 2)).toBe("passed");
  expect(report.finalChecks.every((check) => check.status === "passed")).toBe(
    true,
  );
}

describe("browser-portal — fixture routing regression test (handleTurn string-match)", () => {
  test("executive assistant portal upload scenario passes", async () => {
    await expectScenarioPasses(
      portalUploadScenario,
      "lifeops-browser-portal-upload-scenario",
    );
  });

  test("executive assistant id-copy escalation scenario passes", async () => {
    await expectScenarioPasses(
      collectIdCopyScenario,
      "lifeops-browser-id-copy-scenario",
    );
  });

  test("connector certification browser portal scenario passes", async () => {
    await expectScenarioPasses(
      browserPortalConnectorScenario,
      "lifeops-browser-portal-connector-scenario",
    );
  });
});
