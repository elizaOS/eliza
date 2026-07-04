/**
 * Scenario-runner scenario asserting a view-plugin coding task surfaces the cloud
 * deploy guidance and mock cloud-deploy result the planner needs.
 */
import type { ScenarioContext } from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";
import {
  installOrchestratorScenarioHarness,
  ORCHESTRATOR_SCENARIO_PLUGIN_NAME,
  ORCHESTRATOR_VIEW_CLOUD_DEPLOY,
} from "./_helpers/orchestrator-scenario-harness";

function objectValue(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return Object.fromEntries(Object.entries(value));
}

function actionData(ctx: ScenarioContext): Record<string, unknown> | null {
  const action = ctx.actionsCalled.find(
    (candidate) => candidate.actionName === ORCHESTRATOR_VIEW_CLOUD_DEPLOY,
  );
  return objectValue(action?.result?.data);
}

function cloudMockData(
  data: Record<string, unknown> | null,
): Record<string, unknown> | null {
  const cloudMock = data?.cloudMock;
  return objectValue(cloudMock);
}

function firstManifestView(
  manifest: Record<string, unknown> | undefined,
): Record<string, unknown> | null {
  const views = manifest?.views;
  if (!Array.isArray(views)) return null;
  return objectValue(views[0]);
}

function cloudCalls(
  cloudMock: Record<string, unknown> | null,
): Record<string, unknown>[] {
  return Array.isArray(cloudMock?.calls)
    ? cloudMock.calls.map(objectValue).filter((call) => call !== null)
    : [];
}

function headersValue(
  call: Record<string, unknown> | undefined,
): Record<string, string> {
  const headers = objectValue(call?.headers);
  return Object.fromEntries(
    Object.entries(headers ?? {}).filter((entry): entry is [string, string] => {
      return typeof entry[1] === "string";
    }),
  );
}

export default scenario({
  id: "orchestrator-view-cloud-deploy",
  lane: "pr-deterministic",
  title: "Cloud-targeted view-plugin guidance records apps.create and viewKind",
  domain: "agent-orchestrator",
  tags: [
    "orchestrator",
    "view-plugin",
    "cloud",
    "apps.create",
    "viewKind",
    "pr",
    "deterministic",
  ],
  isolation: "shared-runtime",
  requires: {
    plugins: [ORCHESTRATOR_SCENARIO_PLUGIN_NAME],
  },
  seed: [
    {
      type: "custom",
      name: "install deterministic view cloud deploy harness",
      apply: async (ctx) => {
        await installOrchestratorScenarioHarness(ctx);
        return undefined;
      },
    },
  ],
  turns: [
    {
      kind: "action",
      name: "run cloud-targeted view plugin deploy guidance against mock cloud",
      text: "Exercise cloud-targeted view plugin deployment guidance.",
      actionName: ORCHESTRATOR_VIEW_CLOUD_DEPLOY,
      responseIncludesAny: [
        "cloud:mock registered the view plugin",
        "apps.create",
        "viewKind",
      ],
      assertTurn: (turn) => {
        const data = objectValue(turn.actionsCalled[0]?.result?.data);
        const guidance = String(data?.guidance ?? "");
        for (const needle of [
          "View Plugin Deployment (Eliza Cloud)",
          "Build the view bundle",
          "apps.create",
          "viewKind",
          "Cloud CDN `bundleUrl`",
          "X-Affiliate-Code",
          "Cloud app sandboxes are isolated and ephemeral",
        ]) {
          if (!guidance.includes(needle)) {
            return `expected guidance to include ${needle}`;
          }
        }
        const cloudMock = cloudMockData(data);
        const call = cloudCalls(cloudMock)[0];
        if (call?.command !== "apps.create") {
          return `expected apps.create cloud mock call, saw ${String(call?.command)}`;
        }
        const body = objectValue(call.body);
        const manifest = objectValue(body?.manifest) ?? undefined;
        const view = firstManifestView(manifest);
        if (view?.viewKind !== "release") {
          return `expected release viewKind, saw ${String(view?.viewKind)}`;
        }
        if (
          !String(view.bundleUrl ?? "").startsWith("https://cdn.eliza.cloud/")
        ) {
          return `expected Cloud CDN bundleUrl, saw ${String(view.bundleUrl)}`;
        }
        if (headersValue(call)["X-Affiliate-Code"] !== "aff_8918") {
          return "expected affiliate header to be forwarded";
        }
        return undefined;
      },
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      actionName: ORCHESTRATOR_VIEW_CLOUD_DEPLOY,
      status: "success",
    },
    {
      type: "custom",
      name: "mock cloud recorded apps.create with viewKind manifest",
      predicate: (ctx) => {
        const data = actionData(ctx);
        const cloudMock = cloudMockData(data);
        const calls = cloudCalls(cloudMock);
        const appsCreate = calls.find((call) => call.command === "apps.create");
        if (!appsCreate) return "expected an apps.create mock cloud call";
        const body = objectValue(appsCreate.body);
        const manifest = objectValue(body?.manifest) ?? undefined;
        const view = firstManifestView(manifest);
        if (manifest?.viewKind !== "release") {
          return `expected manifest viewKind release, saw ${String(manifest?.viewKind)}`;
        }
        if (view?.viewKind !== "release") {
          return `expected view viewKind release, saw ${String(view?.viewKind)}`;
        }
        if (
          view?.bundleUrl !==
          "https://cdn.eliza.cloud/apps/weather-panel/weather-panel.js"
        ) {
          return `expected Cloud CDN bundleUrl, saw ${String(view?.bundleUrl)}`;
        }
        if (headersValue(appsCreate)["X-Affiliate-Code"] !== "aff_8918") {
          return "expected X-Affiliate-Code header in mock cloud call";
        }
        return undefined;
      },
    },
  ],
});
