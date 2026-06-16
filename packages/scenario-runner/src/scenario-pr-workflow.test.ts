import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workflowPath = resolve(
  import.meta.dirname,
  "../../../.github/workflows/scenario-pr.yml",
);
const cloudWorkflowPath = resolve(
  import.meta.dirname,
  "../../../.github/workflows/cloud-tests.yml",
);
const rootPackagePath = resolve(import.meta.dirname, "../../../package.json");
const scenarioRunnerPackagePath = resolve(
  import.meta.dirname,
  "../package.json",
);
const scenarioExecutorPath = resolve(import.meta.dirname, "./executor.ts");
const appAssistantFlowPath = resolve(
  import.meta.dirname,
  "../../app/test/ui-smoke/assistant-home-flow.spec.ts",
);
const appScreenshotQualityPath = resolve(
  import.meta.dirname,
  "../../app/test/ui-smoke/helpers/screenshot-quality.ts",
);
const appDesignReviewPaths = [
  "../../app/test/design-review/run-design-review.ts",
].map((relativePath) => resolve(import.meta.dirname, relativePath));
const voiceFlowPath = resolve(
  import.meta.dirname,
  "../../ui/src/hooks/useVoiceChat.bidirectional.test.tsx",
);
const continuousChatFlowPath = resolve(
  import.meta.dirname,
  "../../ui/src/hooks/useContinuousChat.test.tsx",
);
const appTtsSttFlowPath = resolve(
  import.meta.dirname,
  "../../app/test/ui-smoke/tts-stt-e2e.spec.ts",
);
const dynamicViewLoaderPath = resolve(
  import.meta.dirname,
  "../../ui/src/components/views/DynamicViewLoader.test.tsx",
);
const appViewManagerFlowPath = resolve(
  import.meta.dirname,
  "../../app/test/ui-smoke/view-manager-actual-flow.spec.ts",
);
const appPackagedRegressionPath = resolve(
  import.meta.dirname,
  "../../app/test/electrobun-packaged/electrobun-packaged-regressions.e2e.spec.ts",
);
const appCoreLiveScreenshotPaths = [
  "../../app-core/test/app/memory-relationships.real.e2e.test.ts",
  "../../app-core/test/app/qa-checklist.real.e2e.test.ts",
  "../../app-core/test/app/first-run-companion.live.e2e.test.ts",
].map((relativePath) => resolve(import.meta.dirname, relativePath));
const computerUseBrowserPath = resolve(
  import.meta.dirname,
  "../../../plugins/plugin-computeruse/src/platform/browser.ts",
);
const computerUseScreenshotQualityPath = resolve(
  import.meta.dirname,
  "../../../plugins/plugin-computeruse/src/platform/screenshot-quality.ts",
);
const llmProxyPath = resolve(
  import.meta.dirname,
  "../../test/mocks/helpers/llm-proxy-plugin.ts",
);
const llmProxyTestPath = resolve(
  import.meta.dirname,
  "../../test/mocks/__tests__/llm-proxy-plugin.test.ts",
);
const deterministicPrScenarioPath = resolve(
  import.meta.dirname,
  "../test/scenarios/deterministic-pr-smoke.scenario.ts",
);
const deterministicAppControlActionsScenarioPath = resolve(
  import.meta.dirname,
  "../test/scenarios/deterministic-app-control-actions.scenario.ts",
);
const deterministicGeneratedAppRoutesScenarioPath = resolve(
  import.meta.dirname,
  "../test/scenarios/deterministic-generated-app-routes.scenario.ts",
);
const deterministicTodosActionsScenarioPath = resolve(
  import.meta.dirname,
  "../test/scenarios/deterministic-todos-actions.scenario.ts",
);
const deterministicStreamingActionsScenarioPath = resolve(
  import.meta.dirname,
  "../test/scenarios/deterministic-streaming-actions.scenario.ts",
);
const deterministicXrViewActionsScenarioPath = resolve(
  import.meta.dirname,
  "../test/scenarios/deterministic-xr-view-actions.scenario.ts",
);
const deterministicMcpActionsRoutesScenarioPath = resolve(
  import.meta.dirname,
  "../test/scenarios/deterministic-mcp-actions-routes.scenario.ts",
);
const deterministicWorkflowActionsRoutesScenarioPath = resolve(
  import.meta.dirname,
  "../test/scenarios/deterministic-workflow-actions-routes.scenario.ts",
);
const deterministicGithubActionsRoutesScenarioPath = resolve(
  import.meta.dirname,
  "../test/scenarios/deterministic-github-actions-routes.scenario.ts",
);
const deterministicAppControlNlRoutingScenarioPath = resolve(
  import.meta.dirname,
  "../test/scenarios/deterministic-app-control-nl-routing.scenario.ts",
);
const deterministicBrowserActionsScenarioPath = resolve(
  import.meta.dirname,
  "../test/scenarios/deterministic-browser-actions.scenario.ts",
);
const deterministicLifeOpsScheduledTasksScenarioPath = resolve(
  import.meta.dirname,
  "../test/scenarios/deterministic-lifeops-scheduled-tasks.scenario.ts",
);
const deterministicCodingToolsActionsScenarioPath = resolve(
  import.meta.dirname,
  "../test/scenarios/deterministic-coding-tools-actions.scenario.ts",
);
const deterministicAgentSkillsActionsScenarioPath = resolve(
  import.meta.dirname,
  "../test/scenarios/deterministic-agent-skills-actions.scenario.ts",
);
const deterministicMediaEmoteActionsScenarioPath = resolve(
  import.meta.dirname,
  "../test/scenarios/deterministic-media-emote-actions.scenario.ts",
);
const deterministicScenarioReadmePath = resolve(
  import.meta.dirname,
  "../test/scenarios/README.md",
);
const appControlViewsManagementPath = resolve(
  import.meta.dirname,
  "../../../plugins/plugin-app-control/src/actions/views-management.test.ts",
);
const appVerificationIntegrationPath = resolve(
  import.meta.dirname,
  "../../../plugins/plugin-app-control/src/services/__tests__/app-verification.integration.test.ts",
);

describe("scenario PR workflow contract", () => {
  it("runs deterministic zero-cost coverage on every PR without path filtering", () => {
    const workflow = readFileSync(workflowPath, "utf8");
    const deterministicPrScenario = readFileSync(
      deterministicPrScenarioPath,
      "utf8",
    );
    const deterministicAppControlActionsScenario = readFileSync(
      deterministicAppControlActionsScenarioPath,
      "utf8",
    );
    const deterministicGeneratedAppRoutesScenario = readFileSync(
      deterministicGeneratedAppRoutesScenarioPath,
      "utf8",
    );
    const deterministicTodosActionsScenario = readFileSync(
      deterministicTodosActionsScenarioPath,
      "utf8",
    );
    const deterministicStreamingActionsScenario = readFileSync(
      deterministicStreamingActionsScenarioPath,
      "utf8",
    );
    const deterministicXrViewActionsScenario = readFileSync(
      deterministicXrViewActionsScenarioPath,
      "utf8",
    );
    const deterministicMcpActionsRoutesScenario = readFileSync(
      deterministicMcpActionsRoutesScenarioPath,
      "utf8",
    );
    const deterministicWorkflowActionsRoutesScenario = readFileSync(
      deterministicWorkflowActionsRoutesScenarioPath,
      "utf8",
    );
    const deterministicGithubActionsRoutesScenario = readFileSync(
      deterministicGithubActionsRoutesScenarioPath,
      "utf8",
    );
    const deterministicAppControlNlRoutingScenario = readFileSync(
      deterministicAppControlNlRoutingScenarioPath,
      "utf8",
    );
    const deterministicBrowserActionsScenario = readFileSync(
      deterministicBrowserActionsScenarioPath,
      "utf8",
    );
    const deterministicLifeOpsScheduledTasksScenario = readFileSync(
      deterministicLifeOpsScheduledTasksScenarioPath,
      "utf8",
    );
    const deterministicCodingToolsActionsScenario = readFileSync(
      deterministicCodingToolsActionsScenarioPath,
      "utf8",
    );
    const deterministicAgentSkillsActionsScenario = readFileSync(
      deterministicAgentSkillsActionsScenarioPath,
      "utf8",
    );
    const deterministicMediaEmoteActionsScenario = readFileSync(
      deterministicMediaEmoteActionsScenarioPath,
      "utf8",
    );
    const deterministicScenarioReadme = readFileSync(
      deterministicScenarioReadmePath,
      "utf8",
    );
    const scenarioRunnerPackage = JSON.parse(
      readFileSync(scenarioRunnerPackagePath, "utf8"),
    ) as { scripts?: Record<string, string> };
    const scenarioExecutor = readFileSync(scenarioExecutorPath, "utf8");
    const appControlViewsManagement = readFileSync(
      appControlViewsManagementPath,
      "utf8",
    );
    const appVerificationIntegration = readFileSync(
      appVerificationIntegrationPath,
      "utf8",
    );
    const llmProxy = readFileSync(llmProxyPath, "utf8");
    const llmProxyTest = readFileSync(llmProxyTestPath, "utf8");

    expect(workflow).toContain("pull_request:");
    expect(workflow).not.toMatch(/\n\s+paths:\s*\n/);
    expect(workflow).toContain('SCENARIO_USE_LLM_PROXY: "1"');
    expect(workflow).toContain(
      "bunx vitest run --config test/mocks/vitest.config.ts test/mocks/__tests__/llm-proxy-plugin.test.ts",
    );
    expect(workflow).toContain(
      "bun run --cwd packages/ui test -- src/hooks/useVoiceChat.bidirectional.test.tsx src/hooks/useContinuousChat.test.tsx",
    );
    expect(workflow).toContain(
      "src/components/shell/__tests__/shell-assistant-flow.test.tsx",
    );
    expect(workflow).toContain("bunx playwright install --with-deps chromium");
    expect(workflow).toContain(
      'bun run --cwd packages/app test:e2e test/ui-smoke/assistant-home-flow.spec.ts --project=chromium -g "captures first-run, assistant home, chat suppression, and view pill states"',
    );
    expect(workflow).toContain(
      'bun run --cwd packages/app test:e2e test/ui-smoke/assistant-home-flow.spec.ts --project=chromium -g "drives the assistant home voice path with a scripted browser STT turn"',
    );
    expect(workflow).toContain(
      "bun run --cwd packages/app test:e2e test/ui-smoke/tts-stt-e2e.spec.ts --project=chromium",
    );
    expect(workflow).toContain(
      "bun run --cwd packages/app test:e2e test/ui-smoke/view-manager-actual-flow.spec.ts --project=chromium",
    );
    expect(workflow).toContain(
      "bun run --cwd packages/scenario-runner test:pr:e2e",
    );
    expect(scenarioRunnerPackage.scripts?.["test:pr:e2e"]).toBe(
      "bun run test:deterministic:e2e",
    );
    expect(scenarioRunnerPackage.scripts?.["test:deterministic:e2e"]).toContain(
      "SCENARIO_USE_LLM_PROXY=1",
    );
    expect(scenarioRunnerPackage.scripts?.["test:deterministic:e2e"]).toContain(
      "SCENARIO_LLM_PROXY_STRICT=1",
    );
    expect(scenarioRunnerPackage.scripts?.["test:deterministic:e2e"]).toContain(
      "deterministic-pr-smoke,deterministic-app-control-actions,deterministic-generated-app-routes,deterministic-todos-actions,deterministic-streaming-actions,deterministic-xr-view-actions,deterministic-mcp-actions-routes,deterministic-workflow-actions-routes,deterministic-github-actions-routes,deterministic-view-switching,deterministic-app-control-nl-routing,deterministic-browser-actions,deterministic-lifeops-scheduled-tasks,deterministic-coding-tools-actions,deterministic-agent-skills-actions,deterministic-media-emote-actions,deterministic-gitpathology-actions",
    );
    expect(scenarioRunnerPackage.scripts?.["test:live:e2e"]).not.toContain(
      "SCENARIO_USE_LLM_PROXY",
    );
    expect(workflow).toContain(
      "bun run --cwd plugins/plugin-app-control test -- src/actions/views-management.test.ts",
    );
    expect(workflow).toContain(
      "bun run --cwd plugins/plugin-app-control test -- src/services/__tests__/app-verification.integration.test.ts src/services/__tests__/verification-room-bridge.test.ts",
    );
    expect(workflow).toContain(
      "bun run --cwd plugins/plugin-computeruse test -- test/helpers/screenshot-quality.test.ts src/__tests__/browser-auto-open.test.ts",
    );
    expect(workflow).toContain(
      "bun run --cwd packages/app test -- test/screenshot-quality.test.ts",
    );
    expect(workflow).toContain(
      "bun run --cwd packages/app-core test -- test/app/screenshot-quality.test.ts",
    );
    expect(workflow).toContain(
      "bun run --cwd packages/cloud-frontend test -- tests/e2e/screenshot-quality.test.ts",
    );
    expect(workflow).toContain(
      "bun run --cwd packages/app-core/platforms/electrobun test src/native/desktop-window.test.ts src/rpc-handlers.test.ts src/dynamic-view-rpc-schema.test.ts src/surface-windows.test.ts src/dynamic-views/host.test.ts",
    );
    expect(llmProxy).toContain("failOnUnhandledAction");
    expect(llmProxy).toContain(
      "Expected: the E2E prompt must clearly match exactly one provided action/tool.",
    );
    expect(llmProxyTest).toContain(
      "fails closed with actual-vs-expected diagnostics when no planner tool matches",
    );
    expect(llmProxyTest).toContain(
      "fails closed with actual-vs-expected diagnostics when planner tools tie",
    );
    expect(llmProxyTest).toContain(
      "fails Stage 1 with actual-vs-expected diagnostics when no candidate action matches",
    );
    expect(llmProxyTest).toContain(
      "fails Stage 1 with actual-vs-expected diagnostics when candidate actions tie",
    );
    expect(deterministicPrScenario).toContain(
      "Open the remote ledger view in a separate always on top window",
    );
    expect(deterministicPrScenario).toContain(
      "local view loopback API for deterministic shell actions",
    );
    expect(deterministicPrScenario).toContain(
      'Interacted with view "remote-ledger"',
    );
    expect(deterministicPrScenario).toContain(
      "view shell API received exact deterministic requests",
    );
    expect(deterministicPrScenario).toContain("response: { body: { ok: true }");
    expect(deterministicPrScenario).not.toContain(
      "Failed to interact with view",
    );
    expect(deterministicPrScenario).not.toContain("network error.");
    expect(deterministicPrScenario).toContain(
      "deterministic-test-response: hello deterministic proxy",
    );
    expect(deterministicPrScenario).toContain(
      "expected exact deterministic reply",
    );
    expect(deterministicPrScenario).toContain("alwaysOnTop: true");
    expect(deterministicPrScenario).toContain("/alwaysOnTop/");
    expect(deterministicAppControlActionsScenario).toContain(
      "app-control loopback requests and responses are exact",
    );
    expect(deterministicAppControlActionsScenario).toContain(
      "run-feed-relaunch-2",
    );
    expect(deterministicAppControlActionsScenario).toContain(
      'Broadcast view event "wallet:refresh"',
    );
    expect(deterministicAppControlActionsScenario).toContain(
      "data.launch.run.runId",
    );
    expect(deterministicAppControlActionsScenario).toContain(
      "/api/apps/runs/run-feed-old/stop",
    );
    expect(deterministicGeneratedAppRoutesScenario).toContain(
      "Real generated app registry, catalog tile, hero, and route dispatch",
    );
    expect(deterministicGeneratedAppRoutesScenario).toContain(
      "ensureRealAppRegistryService",
    );
    expect(deterministicGeneratedAppRoutesScenario).toContain(
      "/api/apps/hero/${GENERATED_SLUG}",
    );
    expect(deterministicGeneratedAppRoutesScenario).toContain(
      "registerRuntimeAppRouteModule",
    );
    expect(deterministicTodosActionsScenario).toContain(
      "Deterministic TODO action and CURRENT_TODOS provider coverage",
    );
    expect(deterministicTodosActionsScenario).toContain("currentTodosProvider");
    expect(deterministicTodosActionsScenario).toContain("runPluginMigrations");
    expect(deterministicTodosActionsScenario).toContain(
      "ModelType.ACTION_PLANNER",
    );
    expect(deterministicTodosActionsScenario).toContain('actionName: "TODO"');
    expect(deterministicStreamingActionsScenario).toContain(
      "Deterministic STREAM action and route coverage",
    );
    expect(deterministicStreamingActionsScenario).toContain(
      "handleStreamRoute",
    );
    expect(deterministicStreamingActionsScenario).toContain(
      "streamStatusProvider",
    );
    expect(deterministicStreamingActionsScenario).toContain(
      'actionName: "STREAM"',
    );
    expect(deterministicXrViewActionsScenario).toContain(
      "Deterministic XR view actions with real WebSocket service",
    );
    expect(deterministicXrViewActionsScenario).toContain("XRSessionService");
    expect(deterministicXrViewActionsScenario).toContain("encodeBinaryFrame");
    expect(deterministicXrViewActionsScenario).toContain(
      'actionName: "XR_QUERY_VISION"',
    );
    expect(deterministicMcpActionsRoutesScenario).toContain(
      "Deterministic MCP action and route coverage",
    );
    expect(deterministicMcpActionsRoutesScenario).toContain(
      "mcp-stdio-fixture.mjs",
    );
    expect(deterministicMcpActionsRoutesScenario).toContain(
      'actionName: "MCP_READ_RESOURCE"',
    );
    expect(deterministicMcpActionsRoutesScenario).toContain(
      'actionName: "MCP_CALL_TOOL"',
    );
    expect(deterministicMcpActionsRoutesScenario).toContain(
      'actionName: "MCP"',
    );
    expect(deterministicMcpActionsRoutesScenario).toContain(
      'actionName: "MCP_SEARCH_ACTIONS"',
    );
    expect(deterministicMcpActionsRoutesScenario).toContain(
      'actionName: "MCP_LIST_CONNECTIONS"',
    );
    expect(deterministicMcpActionsRoutesScenario).toContain("/api/mcp/status");
    expect(deterministicWorkflowActionsRoutesScenario).toContain(
      "Deterministic workflow action and route coverage",
    );
    expect(deterministicWorkflowActionsRoutesScenario).toContain(
      "EmbeddedWorkflowService",
    );
    expect(deterministicWorkflowActionsRoutesScenario).toContain(
      'actionName: "WORKFLOW"',
    );
    expect(deterministicWorkflowActionsRoutesScenario).toContain(
      "/executions?workflowId=",
    );
    expect(deterministicGithubActionsRoutesScenario).toContain(
      "Deterministic GitHub action and route coverage",
    );
    expect(deterministicGithubActionsRoutesScenario).toContain(
      "setClientForTesting",
    );
    expect(deterministicGithubActionsRoutesScenario).toContain(
      'actionName: "GITHUB_ISSUE_CREATE"',
    );
    expect(deterministicGithubActionsRoutesScenario).toContain(
      'actionName: "GITHUB"',
    );
    expect(deterministicGithubActionsRoutesScenario).toContain(
      'actionName: "GITHUB_ISSUE_ASSIGN"',
    );
    expect(deterministicGithubActionsRoutesScenario).toContain(
      'actionName: "GITHUB_ISSUE_CLOSE"',
    );
    expect(deterministicGithubActionsRoutesScenario).toContain(
      'actionName: "GITHUB_ISSUE_REOPEN"',
    );
    expect(deterministicGithubActionsRoutesScenario).toContain(
      'actionName: "GITHUB_ISSUE_COMMENT"',
    );
    expect(deterministicGithubActionsRoutesScenario).toContain(
      'actionName: "GITHUB_ISSUE_LABEL"',
    );
    expect(deterministicGithubActionsRoutesScenario).toContain(
      'actionName: "GITHUB_PR_LIST"',
    );
    expect(deterministicGithubActionsRoutesScenario).toContain(
      'actionName: "GITHUB_PR_REVIEW"',
    );
    expect(deterministicGithubActionsRoutesScenario).toContain(
      'actionName: "GITHUB_NOTIFICATION_TRIAGE"',
    );
    expect(deterministicGithubActionsRoutesScenario).toContain(
      "/api/github/token",
    );
    expect(deterministicAppControlNlRoutingScenario).toContain(
      "deterministic-app-control-nl-routing",
    );
    expect(deterministicAppControlNlRoutingScenario).toContain(
      "handleResponseFixture",
    );
    expect(deterministicAppControlNlRoutingScenario).toContain(
      "plannerFixture",
    );
    expect(deterministicAppControlNlRoutingScenario).toContain(
      "ModelType.ACTION_PLANNER",
    );
    expect(deterministicAppControlNlRoutingScenario).toContain(
      "strict natural-language routing hit exact app-control APIs",
    );
    expect(deterministicBrowserActionsScenario).toContain(
      "Deterministic browser workspace action catalog",
    );
    expect(deterministicBrowserActionsScenario).toContain(
      "typed by strict browser scenario",
    );
    expect(deterministicBrowserActionsScenario).toContain("BROWSER_SCREENSHOT");
    expect(deterministicLifeOpsScheduledTasksScenario).toContain(
      "Deterministic LifeOps ScheduledTask action execution",
    );
    expect(deterministicLifeOpsScheduledTasksScenario).toContain(
      "SCHEDULED_TASKS action ledger is exact and successful",
    );
    expect(deterministicLifeOpsScheduledTasksScenario).toContain(
      "snoozed until ",
    );
    expect(deterministicCodingToolsActionsScenario).toContain(
      "Deterministic coding-tools action execution",
    );
    expect(deterministicCodingToolsActionsScenario).toContain(
      "coding-tools action ledger and filesystem side effects are exact",
    );
    expect(deterministicCodingToolsActionsScenario).toContain(
      "scenario-coding-tools-branch",
    );
    expect(deterministicAgentSkillsActionsScenario).toContain(
      "Deterministic agent-skills action catalog",
    );
    expect(deterministicAgentSkillsActionsScenario).toContain(
      "mock ClawHub registry",
    );
    expect(deterministicAgentSkillsActionsScenario).toContain(
      "SKILL_UNINSTALL",
    );
    expect(deterministicMediaEmoteActionsScenario).toContain(
      "Deterministic media generation and companion emote actions",
    );
    expect(deterministicMediaEmoteActionsScenario).toContain(
      "GENERATE_MEDIA_AUDIO",
    );
    expect(deterministicMediaEmoteActionsScenario).toContain("PLAY_EMOTE");
    expect(deterministicScenarioReadme).toContain(
      "strict Stage 1 and planner fixtures",
    );
    expect(deterministicScenarioReadme).toContain(
      "browser plugin's keyless web/JSDOM",
    );
    expect(deterministicScenarioReadme).toContain(
      "`SCHEDULED_TASKS` handler and repository-backed",
    );
    expect(deterministicScenarioReadme).toContain(
      "isolated throwaway git repo",
    );
    expect(deterministicScenarioReadme).toContain(
      "mocked ClawHub registry/download endpoint",
    );
    expect(deterministicScenarioReadme).toContain(
      "real AppRegistryService and app-manager routes",
    );
    expect(deterministicScenarioReadme).toContain("real TodosService DB state");
    expect(deterministicScenarioReadme).toContain("CURRENT_TODOS");
    expect(deterministicScenarioReadme).toContain("real `STREAM` action");
    expect(deterministicScenarioReadme).toContain("route handler");
    expect(deterministicScenarioReadme).toContain(
      "real XRSessionService WebSocket",
    );
    expect(deterministicScenarioReadme).toContain(
      "committed stdio MCP fixture",
    );
    expect(deterministicScenarioReadme).toContain("MCP_CALL_TOOL");
    expect(deterministicScenarioReadme).toContain(
      "real embedded workflow services",
    );
    expect(deterministicScenarioReadme).toContain("fake Octokit client");
    expect(deterministicScenarioReadme).toContain("GITHUB_NOTIFICATION_TRIAGE");
    expect(deterministicScenarioReadme).toContain(
      "deterministic runtime model handlers",
    );
    expect(deterministicScenarioReadme).toContain(
      "runtime currently removes `UPDATE_ENTITY`",
    );
    expect(scenarioExecutor).toContain(
      "../../../plugins/plugin-app-control/src/index.ts",
    );
    expect(scenarioExecutor).toContain(
      "actions: [mod.appAction, mod.homescreenAction, mod.viewsAction]",
    );
    expect(appControlViewsManagement).toContain(
      "owner-gates mutating view management modes but allows window navigation validation",
    );
    expect(appControlViewsManagement).toContain(
      "includes explicit TUI view type and always-on-top false in window navigation payloads",
    );
    expect(appControlViewsManagement).toContain(
      "http://127.0.0.1:3456/api/views/remote-ledger/navigate?viewType=tui",
    );
    expect(appControlViewsManagement).toContain("alwaysOnTop: false");
    expect(appVerificationIntegration).toContain(
      "fails structured proof with explicit expected-vs-actual kind and name-field diagnostics",
    );
    expect(appVerificationIntegration).toContain(
      "structured proof kind must be APP_CREATE_DONE; received PLUGIN_CREATE_DONE",
    );
    expect(appVerificationIntegration).toContain(
      "structured proof pluginName is invalid for APP_CREATE_DONE",
    );
  });

  it("keeps cloud Playwright CI wired to real Playwright, including visual screenshot checks", () => {
    const workflow = readFileSync(cloudWorkflowPath, "utf8");
    const rootPackage = JSON.parse(readFileSync(rootPackagePath, "utf8")) as {
      scripts?: Record<string, string>;
    };

    expect(workflow).toContain("pull_request:");
    expect(workflow).toContain("Run Playwright tests");
    expect(workflow).toContain("project: [chromium-desktop, chromium-mobile]");
    const matrixProjectExpression = ["$", "{{ matrix.project }}"].join("");
    expect(workflow).toContain(
      "bun run --cwd packages/cloud-frontend test:e2e -- --project=" +
        matrixProjectExpression,
    );
    expect(rootPackage.scripts?.["test:cloud:playwright"]).toBe(
      "bun run --cwd packages/cloud-frontend test:e2e",
    );
    expect(rootPackage.scripts?.["test:cloud:playwright"]).not.toBe(
      "bun run --cwd packages/cloud-frontend test",
    );
  });

  it("keeps actual app screenshots failing on blank or one-color captures", () => {
    const appAssistantFlow = readFileSync(appAssistantFlowPath, "utf8");
    const screenshotQuality = readFileSync(appScreenshotQualityPath, "utf8");

    expect(appAssistantFlow).toContain("captureScreenshotWithQualityRetry");
    expect(screenshotQuality).toContain("screenshot is one color");
    expect(screenshotQuality).toContain("screenshot is effectively one color");
    expect(screenshotQuality).toContain("assertScreenshotNotBlank");
    expect(appAssistantFlow).toContain("installPageDiagnosticsGuard");
    expect(appAssistantFlow).toContain("expectNoPageDiagnostics");
  });

  it("keeps design-review screenshots on the same one-color failure guard", () => {
    for (const scriptPath of appDesignReviewPaths) {
      const script = readFileSync(scriptPath, "utf8");
      expect(script).toContain("captureScreenshotWithQualityRetry");
      expect(script).not.toContain(".screenshot({ path:");
    }
  });

  it("keeps packaged desktop screenshots failing on blank or one-color captures", () => {
    const packagedRegression = readFileSync(appPackagedRegressionPath, "utf8");

    expect(packagedRegression).toContain("assertScreenshotNotBlank");
    expect(packagedRegression).toContain("throw error");
  });

  it("keeps app-core live screenshots failing on blank or one-color captures", () => {
    for (const scriptPath of appCoreLiveScreenshotPaths) {
      const script = readFileSync(scriptPath, "utf8");
      expect(script).toContain("captureScreenshotWithQualityRetry");
      expect(script).not.toContain("await page.screenshot");
    }
  });

  it("keeps computer-use browser screenshots failing on blank or one-color captures", () => {
    const browser = readFileSync(computerUseBrowserPath, "utf8");
    const screenshotQuality = readFileSync(
      computerUseScreenshotQualityPath,
      "utf8",
    );

    expect(browser).toContain("assertScreenshotBase64NotBlank");
    expect(browser).toContain(
      'page.screenshot({ encoding: "base64", type: "png" })',
    );
    expect(screenshotQuality).toContain("screenshot is one color");
    expect(screenshotQuality).toContain("screenshot is effectively one color");
    expect(screenshotQuality).toContain("screenshot quality failed");
  });

  it("keeps actual app pill/chat coverage on repeated open-close-send cycles", () => {
    const appAssistantFlow = readFileSync(appAssistantFlowPath, "utf8");

    for (const required of [
      "shell-home-pill",
      "04-chat-pill-suppressed",
      "05-views-with-pill",
      "07-wallet-view-with-pill",
      "Refresh wallet",
      "open wallet by typing",
      "streamRequests",
      'toHaveValue("")',
      "show me my pinned views",
    ]) {
      expect(appAssistantFlow).toContain(required);
    }
  });

  it("keeps bidirectional and always-on voice coverage in the PR gate", () => {
    const voiceFlow = readFileSync(voiceFlowPath, "utf8");
    const continuousChatFlow = readFileSync(continuousChatFlowPath, "utf8");
    const appTtsSttFlow = readFileSync(appTtsSttFlowPath, "utf8");

    for (const required of [
      "hmm, okay, that's a good idea, let me think for a second",
      "submits final microphone transcript through the real browser recognition path",
      "submits final passive transcripts immediately while keeping always-on recognition alive",
      "keeps hands-free capture alive while speaking the wait phrase",
      "speechSynthesisMock.speak",
      "recognition?.stopped).toBe(false)",
    ]) {
      expect(voiceFlow).toContain(required);
    }

    for (const required of [
      "invokes voice.startListening('passive') when the toggle enters always-on",
      "restores passive capture after an always-on turn completes",
      "button[data-mode='always-on']",
    ]) {
      expect(continuousChatFlow).toContain(required);
    }

    for (const required of [
      "TTS cloud endpoint receives the assistant text + voiceId payload",
      "STT capture path fires onTranscript with the recognized string",
      "always-on chat mode starts passive browser STT and keeps capture open after a final turn",
      "chat SSE stream emits token + done events for assistant message",
      'getByRole("button", { name: /talk|voice input/i })',
      "VOICE_DM",
      "hello world from the STT shim",
      "always on browser turn",
      "Always-on assistant heard the browser turn",
      "eliza:voice:continuous-chat-mode",
      'voiceSource: "browser"',
      "audio/mpeg",
      'types).toEqual(["token", "done"])',
      'outputFormat: "mp3_44100_128"',
      "similarity_boost: 0.75",
      "installPageDiagnosticsGuard",
      "expectNoPageDiagnostics",
      'localStorage.setItem("eliza:voice:continuous-chat-mode", "always-on")',
    ]) {
      expect(appTtsSttFlow).toContain(required);
    }
  });

  it("keeps PR-gated view manager coverage on local and remote create/edit/delete flows", () => {
    const dynamicViewLoader = readFileSync(dynamicViewLoaderPath, "utf8");
    const appViewManagerFlow = readFileSync(appViewManagerFlowPath, "utf8");

    for (const required of [
      "imports absolute remote bundleUrl directly",
      "registers remote view interact handlers after the bundle loads",
      "fills inputs and clicks buttons through standard interact against the mounted DOM",
      "Remote Ledger Updated",
      "dispatchViewInteract",
      "remote.interactive",
    ]) {
      expect(dynamicViewLoader).toContain(required);
    }

    for (const required of [
      "actual app view manager creates, updates, switches, opens, and deletes local and remote dynamic views",
      "Dynamic view management",
      "actual-local-ledger",
      "Actual Local Ledger Updated",
      "actual-remote-ledger",
      "Actual Remote Ledger Updated",
      "dynamicViewRegister",
      "dynamicViewUnregister",
      "captureScreenshotWithQualityRetry",
      "registerCalls",
      "unregisterCalls",
      "installPageDiagnosticsGuard",
      "expectNoPageDiagnostics",
      "opening the local dynamic view must not import the remote bundle",
      "05-remote-updated-reopened",
    ]) {
      expect(appViewManagerFlow).toContain(required);
    }
    expect(appViewManagerFlow).toContain("03-local-switched");
    expect(appViewManagerFlow).toContain("04-remote-module-loaded");
  });
});
