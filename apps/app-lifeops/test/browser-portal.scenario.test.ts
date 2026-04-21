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

describe("browser and portal scenarios", () => {
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
