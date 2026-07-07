/**
 * Keyless catalog coverage for the browser-workspace action surface against a
 * seeded browser tab. Runs on the pr-deterministic lane under the LLM proxy.
 */
import type {
  CapturedAction,
  ScenarioTurnExecution,
} from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";
import { browserPlugin } from "../../../../plugins/plugin-browser/src/plugin.ts";
import {
  __resetBrowserWorkspaceStateForTests,
  ensureBrowserWorkspaceDefaultTab,
  executeBrowserWorkspaceCommand,
} from "../../../../plugins/plugin-browser/src/workspace/browser-workspace.ts";
import {
  type RuntimeWithScenarioLlmFixtures,
  registerStrictActionRouteFixtures,
} from "./_helpers/strict-llm-action-fixtures";

const strictBrowserRoutes = [
  {
    actionName: "BROWSER_GET",
    args: { selector: "#scenario-title" },
    contextIds: ["browser", "web"],
    input: "Read the browser form heading",
    messageToUser: "Browser get result (web):\nScenario Browser Form",
  },
  {
    actionName: "BROWSER_WAIT",
    args: { selector: "#scenario-input", timeoutMs: 4000 },
    contextIds: ["browser", "web"],
    input: "Wait for the browser form input",
    messageToUser:
      'Browser wait result (web):\n{\n  "findBy": null,\n  "selector": "#scenario-input",\n  "state": null,\n  "text": null,\n  "url": "https://scenario.test/form"\n}',
  },
  {
    actionName: "BROWSER_TYPE",
    args: {
      selector: "#scenario-input",
      text: "typed by strict browser scenario",
    },
    contextIds: ["browser", "web"],
    input: "Type deterministic text into the browser form input",
    messageToUser:
      'Browser type result (web):\n{\n  "selector": "#scenario-input",\n  "value": "typed by strict browser scenario"\n}',
  },
  {
    actionName: "BROWSER_CLICK",
    args: { selector: "#scenario-button" },
    contextIds: ["browser", "web"],
    input: "Click the seeded browser form button",
    messageToUser:
      'Browser click result (web):\n{\n  "clickCount": 1,\n  "selector": "#scenario-button",\n  "text": "Submit"\n}',
  },
  {
    actionName: "BROWSER_SCREENSHOT",
    args: {},
    contextIds: ["browser", "web"],
    input: "Capture a browser workspace screenshot",
    messageToUser: "Browser screenshot captured a preview in web mode.",
  },
  {
    actionName: "BROWSER_OPEN",
    args: { url: "about:blank" },
    contextIds: ["browser", "web"],
    input: "Open another browser tab",
    messageToUser: "open completed in web mode.\nNew Tab\nabout:blank",
  },
  {
    actionName: "BROWSER_LIST_TABS",
    args: {},
    contextIds: ["browser", "web"],
    input: "List the browser workspace tabs",
    messageToUser:
      "Browser tabs (web):\n- Scenario Browser Form (https://scenario.test/form)\n- New Tab (about:blank)",
  },
  {
    actionName: "BROWSER_CLOSE",
    args: {},
    contextIds: ["browser", "web"],
    input: "Close the current browser workspace tab",
    messageToUser: "Browser closed (web).",
  },
];

const WAIT_FOR_URL_START_URL = "https://scenario.test/oauth/start";
const WAIT_FOR_URL_CALLBACK_URL =
  "https://scenario.test/oauth/callback?code=scenario";
const WAIT_FOR_URL_PATTERN = "callback?code=scenario";
const SEEDED_FORM_TAB_ID = "btab_1";
let waitForUrlCallbackTimer: ReturnType<typeof setInterval> | null = null;

function clearWaitForUrlCallbackTimer(): void {
  if (waitForUrlCallbackTimer) {
    clearInterval(waitForUrlCallbackTimer);
    waitForUrlCallbackTimer = null;
  }
}

function scheduleWaitForUrlCallbackNavigation(): void {
  clearWaitForUrlCallbackTimer();
  const startedAt = Date.now();
  let startSeenAt: number | null = null;
  waitForUrlCallbackTimer = setInterval(() => {
    void (async () => {
      const tabs = await executeBrowserWorkspaceCommand({ subaction: "list" });
      const waitTab = tabs.tabs?.find(
        (tab) => tab.url === WAIT_FOR_URL_START_URL,
      );
      if (waitTab?.id) {
        startSeenAt ??= Date.now();
        if (Date.now() - startSeenAt < 150) {
          return;
        }
        clearWaitForUrlCallbackTimer();
        await executeBrowserWorkspaceCommand({
          id: waitTab.id,
          subaction: "navigate",
          url: WAIT_FOR_URL_CALLBACK_URL,
        });
        return;
      }

      if (Date.now() - startedAt > 3_000) {
        clearWaitForUrlCallbackTimer();
      }
    })().catch(() => {
      if (Date.now() - startedAt > 3_000) {
        clearWaitForUrlCallbackTimer();
      }
    });
  }, 50);
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function actionParameters(value: unknown): Record<string, unknown> {
  const params = toRecord(value);
  return toRecord(params.parameters ?? params);
}

function readPath(value: unknown, path: string): unknown {
  let current = value;
  for (const segment of path.split(".").filter(Boolean)) {
    if (Array.isArray(current) && /^\d+$/.test(segment)) {
      current = current[Number(segment)];
      continue;
    }
    current = toRecord(current)[segment];
  }
  return current;
}

function valuesEqual(actual: unknown, expected: unknown): boolean {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function expectBrowserWaitForUrlTurn(
  execution: ScenarioTurnExecution,
): string | undefined {
  const action = execution.actionsCalled.find(
    (candidate) => candidate.actionName === "BROWSER_WAIT_FOR_URL",
  ) as CapturedAction | undefined;
  if (!action) {
    return `expected BROWSER_WAIT_FOR_URL action, saw ${execution.actionsCalled.map((candidate) => candidate.actionName).join(", ") || "none"}`;
  }

  if (action.result?.success !== true) {
    return `expected BROWSER_WAIT_FOR_URL success=true, saw ${JSON.stringify(action.result)}`;
  }

  const params = actionParameters(action.parameters);
  for (const [key, expectedValue] of Object.entries({
    action: "wait_for_url",
    id: SEEDED_FORM_TAB_ID,
    pattern: WAIT_FOR_URL_PATTERN,
    pollIntervalMs: 50,
    timeoutMs: 4_000,
    url: WAIT_FOR_URL_START_URL,
  })) {
    if (!valuesEqual(params[key], expectedValue)) {
      return `expected BROWSER_WAIT_FOR_URL parameter ${key}=${JSON.stringify(expectedValue)}, saw ${JSON.stringify(params[key])}`;
    }
  }

  const checks: Record<string, unknown> = {
    "values.subaction": "wait_for_url",
    "values.status": "matched",
    "values.matched": true,
    "data.subaction": "wait_for_url",
    "data.outcome.status": "matched",
    "data.outcome.matched": true,
    "data.outcome.pattern": WAIT_FOR_URL_PATTERN,
    "data.outcome.lastUrl": WAIT_FOR_URL_CALLBACK_URL,
  };
  for (const [path, expectedValue] of Object.entries(checks)) {
    const actual = readPath(action.result, path);
    if (!valuesEqual(actual, expectedValue)) {
      return `expected BROWSER_WAIT_FOR_URL result.${path}=${JSON.stringify(expectedValue)}, saw ${JSON.stringify(actual)}`;
    }
  }

  const polls = readPath(action.result, "data.outcome.polls");
  if (typeof polls !== "number" || polls < 2) {
    return `expected BROWSER_WAIT_FOR_URL to poll at least twice before matching, saw ${JSON.stringify(polls)}`;
  }

  const responseText = execution.responseText ?? "";
  for (const expected of [
    `I opened ${WAIT_FOR_URL_START_URL}`,
    `watching for "${WAIT_FOR_URL_PATTERN}"`,
    `still waiting for "${WAIT_FOR_URL_PATTERN}"`,
    `tab reached ${WAIT_FOR_URL_CALLBACK_URL}`,
  ]) {
    if (!responseText.includes(expected)) {
      return `expected BROWSER_WAIT_FOR_URL streamed response to include ${JSON.stringify(expected)}, saw ${JSON.stringify(responseText)}`;
    }
  }

  return undefined;
}

function expectRestoreFormTurn(
  execution: ScenarioTurnExecution,
): string | undefined {
  const action = execution.actionsCalled.find(
    (candidate) => candidate.actionName === "BROWSER_NAVIGATE",
  ) as CapturedAction | undefined;
  if (!action) {
    return `expected BROWSER_NAVIGATE action, saw ${execution.actionsCalled.map((candidate) => candidate.actionName).join(", ") || "none"}`;
  }

  if (action.result?.success !== true) {
    return `expected BROWSER_NAVIGATE success=true, saw ${JSON.stringify(action.result)}`;
  }

  const params = actionParameters(action.parameters);
  for (const [key, expectedValue] of Object.entries({
    action: "navigate",
    id: SEEDED_FORM_TAB_ID,
    url: "https://scenario.test/form",
  })) {
    if (!valuesEqual(params[key], expectedValue)) {
      return `expected BROWSER_NAVIGATE parameter ${key}=${JSON.stringify(expectedValue)}, saw ${JSON.stringify(params[key])}`;
    }
  }

  for (const [path, expectedValue] of Object.entries({
    "values.mode": "web",
    "values.subaction": "navigate",
    "data.result.tab.id": SEEDED_FORM_TAB_ID,
    "data.result.tab.url": "https://scenario.test/form",
  })) {
    const actual = readPath(action.result, path);
    if (!valuesEqual(actual, expectedValue)) {
      return `expected BROWSER_NAVIGATE result.${path}=${JSON.stringify(expectedValue)}, saw ${JSON.stringify(actual)}`;
    }
  }

  return undefined;
}

function expectActionTurn(
  execution: ScenarioTurnExecution,
  expected: {
    actionName: string;
    parameters: Record<string, unknown>;
    responseText: string;
    resultFields: Record<string, unknown>;
  },
): string | undefined {
  const action = execution.actionsCalled.find(
    (candidate) => candidate.actionName === expected.actionName,
  ) as CapturedAction | undefined;
  if (!action) {
    return `expected ${expected.actionName} action, saw ${execution.actionsCalled.map((candidate) => candidate.actionName).join(", ") || "none"}`;
  }

  if (action.result?.text !== expected.responseText) {
    return `expected ${expected.actionName} result.text=${JSON.stringify(expected.responseText)}, saw responseText=${JSON.stringify(execution.responseText)}, result.text=${JSON.stringify(action.result?.text)}`;
  }

  const params = actionParameters(action.parameters);
  for (const [key, expectedValue] of Object.entries(expected.parameters)) {
    if (!valuesEqual(params[key], expectedValue)) {
      return `expected ${expected.actionName} parameter ${key}=${JSON.stringify(expectedValue)}, saw ${JSON.stringify(params[key])}`;
    }
  }

  if (action.result?.success !== true) {
    return `expected ${expected.actionName} result.success=true, saw ${JSON.stringify(action.result)}`;
  }

  for (const [path, expectedValue] of Object.entries(expected.resultFields)) {
    const actual = readPath(action.result, path);
    if (!valuesEqual(actual, expectedValue)) {
      return `expected ${expected.actionName} result.${path}=${JSON.stringify(expectedValue)}, saw ${JSON.stringify(actual)}`;
    }
  }

  return undefined;
}

export default scenario({
  id: "deterministic-browser-actions",
  lane: "pr-deterministic",
  title: "Deterministic browser workspace action catalog",
  domain: "scenario-runner",
  tags: ["pr", "deterministic", "zero-cost", "browser"],
  isolation: "shared-runtime",
  requires: {
    plugins: ["@elizaos/plugin-browser"],
  },
  seed: [
    {
      type: "custom",
      name: "register browser plugin and seed a JSDOM workspace tab",
      apply: async (ctx) => {
        delete process.env.ELIZA_BROWSER_WORKSPACE_URL;
        delete process.env.ELIZA_BROWSER_WORKSPACE_TOKEN;
        await __resetBrowserWorkspaceStateForTests();

        const runtime = ctx.runtime as
          | ({
              plugins?: Array<{ name?: string }>;
              registerPlugin?: (plugin: typeof browserPlugin) => Promise<void>;
            } & RuntimeWithScenarioLlmFixtures)
          | undefined;
        if (!runtime?.registerPlugin) {
          return "runtime.registerPlugin unavailable";
        }
        if (
          !runtime.plugins?.some(
            (plugin) =>
              plugin.name === "@elizaos/plugin-browser" ||
              plugin.name === "browser",
          )
        ) {
          await runtime.registerPlugin(browserPlugin);
        }

        // BrowserService.start() seeds a default search tab asynchronously.
        // Drive that seeding to completion (idempotent — returns the existing
        // tab if start() already ran) BEFORE the reset, so the reset clears it
        // and the scenario's own tab deterministically lands at btab_1 instead
        // of racing the default tab into btab_1 (which orphaned a duplicate
        // scenario.test tab in the tab ledger).
        await ensureBrowserWorkspaceDefaultTab();
        await __resetBrowserWorkspaceStateForTests();
        const opened = await executeBrowserWorkspaceCommand({
          show: true,
          subaction: "open",
          title: "Scenario Browser Seed",
          url: "about:blank",
        });
        const tabId = opened.tab?.id;
        if (!tabId) {
          return "browser seed did not create a tab";
        }
        await executeBrowserWorkspaceCommand({
          id: tabId,
          networkAction: "route",
          responseBody: [
            "<!doctype html>",
            "<html>",
            "<head><title>Scenario Browser Form</title></head>",
            "<body>",
            '<main id="scenario-root">',
            '<h1 id="scenario-title">Scenario Browser Form</h1>',
            '<label for="scenario-input">Value</label>',
            '<input id="scenario-input" name="value" />',
            '<button id="scenario-button" type="button">Submit</button>',
            "</main>",
            "</body>",
            "</html>",
          ].join(""),
          responseStatus: 200,
          subaction: "network",
          url: "https://scenario.test/form",
        });
        await executeBrowserWorkspaceCommand({
          id: tabId,
          subaction: "navigate",
          url: "https://scenario.test/form",
        });

        scheduleWaitForUrlCallbackNavigation();
        registerStrictActionRouteFixtures(runtime, strictBrowserRoutes);
        return undefined;
      },
    },
  ],
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "Deterministic Browser Catalog",
    },
  ],
  turns: [
    {
      kind: "action",
      name: "wait for browser URL callback",
      actionName: "BROWSER_WAIT_FOR_URL",
      text: "Open the OAuth start page and wait for the callback URL",
      timeoutMs: 8_000,
      options: {
        parameters: {
          action: "wait_for_url",
          id: SEEDED_FORM_TAB_ID,
          pattern: WAIT_FOR_URL_PATTERN,
          pollIntervalMs: 50,
          timeoutMs: 4_000,
          url: WAIT_FOR_URL_START_URL,
        },
      },
      responseIncludesAll: [
        WAIT_FOR_URL_START_URL,
        WAIT_FOR_URL_PATTERN,
        WAIT_FOR_URL_CALLBACK_URL,
      ],
      assertTurn: expectBrowserWaitForUrlTurn,
    },
    {
      kind: "action",
      name: "restore seeded browser form after callback",
      actionName: "BROWSER_NAVIGATE",
      text: "Return the browser workspace to the seeded form",
      options: {
        parameters: {
          action: "navigate",
          id: SEEDED_FORM_TAB_ID,
          url: "https://scenario.test/form",
        },
      },
      responseIncludesAll: ["navigate completed", "https://scenario.test/form"],
      assertTurn: expectRestoreFormTurn,
    },
    {
      kind: "message",
      name: "read seeded browser form heading",
      text: "Read the browser form heading",
      responseIncludesAny: ["Scenario Browser Form"],
      assertTurn: (execution) =>
        expectActionTurn(execution, {
          actionName: "BROWSER_GET",
          parameters: { selector: "#scenario-title" },
          responseText: "Browser get result (web):\nScenario Browser Form",
          resultFields: {
            "values.mode": "web",
            "values.subaction": "get",
            "data.command.selector": "#scenario-title",
            "data.result.value": "Scenario Browser Form",
          },
        }),
    },
    {
      kind: "message",
      name: "wait for seeded browser input",
      text: "Wait for the browser form input",
      responseIncludesAny: ["#scenario-input"],
      assertTurn: (execution) =>
        expectActionTurn(execution, {
          actionName: "BROWSER_WAIT",
          parameters: {
            selector: "#scenario-input",
            timeoutMs: 4000,
          },
          responseText:
            'Browser wait result (web):\n{\n  "findBy": null,\n  "selector": "#scenario-input",\n  "state": null,\n  "text": null,\n  "url": "https://scenario.test/form"\n}',
          resultFields: {
            "values.mode": "web",
            "values.subaction": "wait",
            "data.result.value.selector": "#scenario-input",
            "data.result.value.url": "https://scenario.test/form",
          },
        }),
    },
    {
      kind: "message",
      name: "type into seeded browser input",
      text: "Type deterministic text into the browser form input",
      responseIncludesAny: ["typed by strict browser scenario"],
      assertTurn: (execution) =>
        expectActionTurn(execution, {
          actionName: "BROWSER_TYPE",
          parameters: {
            selector: "#scenario-input",
            text: "typed by strict browser scenario",
          },
          responseText:
            'Browser type result (web):\n{\n  "selector": "#scenario-input",\n  "value": "typed by strict browser scenario"\n}',
          resultFields: {
            "values.mode": "web",
            "values.subaction": "type",
            "data.command.value": "typed by strict browser scenario",
            "data.result.value.selector": "#scenario-input",
            "data.result.value.value": "typed by strict browser scenario",
          },
        }),
    },
    {
      kind: "message",
      name: "click seeded browser button",
      text: "Click the seeded browser form button",
      responseIncludesAny: ["Submit"],
      assertTurn: (execution) =>
        expectActionTurn(execution, {
          actionName: "BROWSER_CLICK",
          parameters: { selector: "#scenario-button" },
          responseText:
            'Browser click result (web):\n{\n  "clickCount": 1,\n  "selector": "#scenario-button",\n  "text": "Submit"\n}',
          resultFields: {
            "values.mode": "web",
            "values.subaction": "click",
            "data.result.value.clickCount": 1,
            "data.result.value.selector": "#scenario-button",
            "data.result.value.text": "Submit",
          },
        }),
    },
    {
      kind: "message",
      name: "capture seeded browser screenshot",
      text: "Capture a browser workspace screenshot",
      responseIncludesAny: ["captured a preview"],
      assertTurn: (execution) =>
        expectActionTurn(execution, {
          actionName: "BROWSER_SCREENSHOT",
          parameters: {},
          responseText: "Browser screenshot captured a preview in web mode.",
          resultFields: {
            "values.mode": "web",
            "values.subaction": "screenshot",
            "data.result.mode": "web",
            "data.result.subaction": "screenshot",
          },
        }),
    },
    {
      kind: "message",
      name: "open an additional browser tab",
      text: "Open another browser tab",
      responseIncludesAny: ["open completed in web mode"],
      assertTurn: (execution) =>
        expectActionTurn(execution, {
          actionName: "BROWSER_OPEN",
          parameters: { url: "about:blank" },
          responseText: "open completed in web mode.\nNew Tab\nabout:blank",
          resultFields: {
            "values.mode": "web",
            "values.subaction": "open",
            "data.result.tab.title": "New Tab",
            "data.result.tab.url": "about:blank",
          },
        }),
    },
    {
      kind: "message",
      name: "list browser tabs",
      text: "List the browser workspace tabs",
      responseIncludesAny: ["Scenario Browser Form", "New Tab"],
      assertTurn: (execution) =>
        expectActionTurn(execution, {
          actionName: "BROWSER_LIST_TABS",
          parameters: {},
          responseText:
            "Browser tabs (web):\n- Scenario Browser Form (https://scenario.test/form)\n- New Tab (about:blank)",
          resultFields: {
            "values.mode": "web",
            "values.subaction": "tab",
            "data.result.tabs.0.title": "Scenario Browser Form",
            "data.result.tabs.1.title": "New Tab",
          },
        }),
    },
    {
      kind: "message",
      name: "close current browser tab",
      text: "Close the current browser workspace tab",
      responseIncludesAny: ["Browser closed (web)."],
      assertTurn: (execution) =>
        expectActionTurn(execution, {
          actionName: "BROWSER_CLOSE",
          parameters: {},
          responseText: "Browser closed (web).",
          resultFields: {
            "values.mode": "web",
            "values.subaction": "close",
            "data.result.closed": true,
          },
        }),
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      actionName: "BROWSER_WAIT_FOR_URL",
      status: "success",
      minCount: 1,
    },
    {
      type: "actionCalled",
      actionName: "BROWSER_GET",
      status: "success",
      minCount: 1,
    },
    {
      type: "actionCalled",
      actionName: "BROWSER_WAIT",
      status: "success",
      minCount: 1,
    },
    {
      type: "actionCalled",
      actionName: "BROWSER_TYPE",
      status: "success",
      minCount: 1,
    },
    {
      type: "actionCalled",
      actionName: "BROWSER_CLICK",
      status: "success",
      minCount: 1,
    },
    {
      type: "actionCalled",
      actionName: "BROWSER_SCREENSHOT",
      status: "success",
      minCount: 1,
    },
    {
      type: "actionCalled",
      actionName: "BROWSER_OPEN",
      status: "success",
      minCount: 1,
    },
    {
      type: "actionCalled",
      actionName: "BROWSER_LIST_TABS",
      status: "success",
      minCount: 1,
    },
    {
      type: "actionCalled",
      actionName: "BROWSER_CLOSE",
      status: "success",
      minCount: 1,
    },
    {
      type: "selectedActionArguments",
      actionName: [
        "BROWSER_GET",
        "BROWSER_WAIT",
        "BROWSER_TYPE",
        "BROWSER_CLICK",
        "BROWSER_OPEN",
      ],
      includesAll: [
        /#scenario-title/,
        /#scenario-input/,
        /typed by strict browser scenario/,
        /#scenario-button/,
        /about:blank/,
      ],
    },
  ],
});
