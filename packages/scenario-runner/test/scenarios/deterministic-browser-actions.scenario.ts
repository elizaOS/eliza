import type {
  CapturedAction,
  ScenarioTurnExecution,
} from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";
import { browserPlugin } from "../../../../plugins/plugin-browser/src/plugin.ts";
import {
  __resetBrowserWorkspaceStateForTests,
  executeBrowserWorkspaceCommand,
} from "../../../../plugins/plugin-browser/src/workspace/browser-workspace.ts";

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

function expectActionTurn(
  execution: ScenarioTurnExecution,
  expected: {
    actionName: string;
    parameters: Record<string, unknown>;
    responseText: string;
    resultFields: Record<string, unknown>;
  },
): string | undefined {
  if (execution.responseText !== expected.responseText) {
    return `expected responseText=${JSON.stringify(expected.responseText)}, saw ${JSON.stringify(execution.responseText)}`;
  }

  const action = execution.actionsCalled.find(
    (candidate) => candidate.actionName === expected.actionName,
  ) as CapturedAction | undefined;
  if (!action) {
    return `expected ${expected.actionName} action, saw ${execution.actionsCalled.map((candidate) => candidate.actionName).join(", ") || "none"}`;
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
        __resetBrowserWorkspaceStateForTests();

        const runtime = ctx.runtime as
          | {
              plugins?: Array<{ name?: string }>;
              registerPlugin?: (plugin: typeof browserPlugin) => Promise<void>;
            }
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

        __resetBrowserWorkspaceStateForTests();
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
      name: "read seeded browser form heading",
      text: "Read the browser form heading",
      actionName: "BROWSER_GET",
      options: { parameters: { selector: "#scenario-title" } },
      responseIncludesAny: ["Scenario Browser Form"],
      assertTurn: (execution) =>
        expectActionTurn(execution, {
          actionName: "BROWSER_GET",
          parameters: { selector: "#scenario-title" },
          responseText:
            "Browser get result (web):\nScenario Browser Form",
          resultFields: {
            "values.mode": "web",
            "values.subaction": "get",
            "data.command.selector": "#scenario-title",
            "data.result.value": "Scenario Browser Form",
          },
        }),
    },
    {
      kind: "action",
      name: "wait for seeded browser input",
      text: "Wait for the browser form input",
      actionName: "BROWSER_WAIT",
      options: { parameters: { selector: "#scenario-input", timeoutMs: 4000 } },
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
      kind: "action",
      name: "type into seeded browser input",
      text: "Type deterministic text into the browser form input",
      actionName: "BROWSER_TYPE",
      options: {
        parameters: {
          selector: "#scenario-input",
          text: "typed by strict browser scenario",
        },
      },
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
      kind: "action",
      name: "click seeded browser button",
      text: "Click the seeded browser form button",
      actionName: "BROWSER_CLICK",
      options: { parameters: { selector: "#scenario-button" } },
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
      kind: "action",
      name: "capture seeded browser screenshot",
      text: "Capture a browser workspace screenshot",
      actionName: "BROWSER_SCREENSHOT",
      options: { parameters: {} },
      responseIncludesAny: ["captured a preview"],
      assertTurn: (execution) =>
        expectActionTurn(execution, {
          actionName: "BROWSER_SCREENSHOT",
          parameters: {},
          responseText:
            "Browser screenshot captured a preview in web mode.",
          resultFields: {
            "values.mode": "web",
            "values.subaction": "screenshot",
            "data.result.mode": "web",
            "data.result.subaction": "screenshot",
          },
        }),
    },
    {
      kind: "action",
      name: "open an additional browser tab",
      text: "Open another browser tab",
      actionName: "BROWSER_OPEN",
      options: { parameters: { url: "about:blank" } },
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
      kind: "action",
      name: "list browser tabs",
      text: "List the browser workspace tabs",
      actionName: "BROWSER_LIST_TABS",
      options: { parameters: {} },
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
      kind: "action",
      name: "close current browser tab",
      text: "Close the current browser workspace tab",
      actionName: "BROWSER_CLOSE",
      options: { parameters: {} },
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
