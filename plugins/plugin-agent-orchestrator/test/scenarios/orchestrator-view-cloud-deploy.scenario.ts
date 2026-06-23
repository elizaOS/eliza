import type { ScenarioContext } from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";
import {
  installOrchestratorScenarioHarness,
  ORCHESTRATOR_SCENARIO_PLUGIN_NAME,
  ORCHESTRATOR_VIEW_CLOUD_DEPLOY,
  registerJudgeFixture,
} from "./_helpers/orchestrator-scenario-harness";

function actionData(ctx: ScenarioContext): Record<string, unknown> | null {
  const action = ctx.actionsCalled.find(
    (candidate) => candidate.actionName === ORCHESTRATOR_VIEW_CLOUD_DEPLOY,
  );
  const data = action?.result?.data;
  return data && typeof data === "object" && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : null;
}

function cloudMockData(data: Record<string, unknown> | null):
  | {
      calls?: Array<{
        command?: unknown;
        body?: Record<string, unknown>;
        headers?: Record<string, string>;
      }>;
      manifest?: Record<string, unknown>;
    }
  | null {
  const cloudMock = data?.cloudMock;
  return cloudMock && typeof cloudMock === "object" && !Array.isArray(cloudMock)
    ? (cloudMock as {
        calls?: Array<{
          command?: unknown;
          body?: Record<string, unknown>;
          headers?: Record<string, string>;
        }>;
        manifest?: Record<string, unknown>;
      })
    : null;
}

function firstManifestView(
  manifest: Record<string, unknown> | undefined,
): Record<string, unknown> | null {
  const views = manifest?.views;
  if (!Array.isArray(views)) return null;
  const first = views[0];
  return first && typeof first === "object" && !Array.isArray(first)
    ? (first as Record<string, unknown>)
    : null;
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
        registerJudgeFixture(
          ctx.runtime as Parameters<typeof registerJudgeFixture>[0],
          ORCHESTRATOR_VIEW_CLOUD_DEPLOY,
        );
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
        const data = turn.actionsCalled[0]?.result?.data as
          | Record<string, unknown>
          | undefined;
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
        const cloudMock = cloudMockData(data ?? null);
        const call = cloudMock?.calls?.[0];
        if (call?.command !== "apps.create") {
          return `expected apps.create cloud mock call, saw ${String(call?.command)}`;
        }
        const manifest = call.body?.manifest as
          | Record<string, unknown>
          | undefined;
        const view = firstManifestView(manifest);
        if (view?.viewKind !== "release") {
          return `expected release viewKind, saw ${String(view?.viewKind)}`;
        }
        if (
          !String(view.bundleUrl ?? "").startsWith("https://cdn.eliza.cloud/")
        ) {
          return `expected Cloud CDN bundleUrl, saw ${String(view.bundleUrl)}`;
        }
        if (call.headers?.["X-Affiliate-Code"] !== "aff_8918") {
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
        const calls = cloudMock?.calls ?? [];
        const appsCreate = calls.find((call) => call.command === "apps.create");
        if (!appsCreate) return "expected an apps.create mock cloud call";
        const manifest = appsCreate.body?.manifest as
          | Record<string, unknown>
          | undefined;
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
        if (appsCreate.headers?.["X-Affiliate-Code"] !== "aff_8918") {
          return "expected X-Affiliate-Code header in mock cloud call";
        }
        return undefined;
      },
    },
    {
      type: "judgeRubric",
      name: "judge verifies view cloud deploy evidence",
      minimumScore: 0.95,
      rubric:
        "Pass only if the trace proves a cloud-targeted view-plugin task received the view deployment guidance and the mock cloud recorded apps.create with a release viewKind manifest, Cloud CDN bundleUrl, and affiliate header.",
    },
  ],
});
