import type {
  CapturedAction,
  ScenarioTurnExecution,
} from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";

function readParameters(action: CapturedAction): Record<string, unknown> {
  return action.parameters &&
    typeof action.parameters === "object" &&
    !Array.isArray(action.parameters)
    ? (action.parameters as Record<string, unknown>)
    : {};
}

const viewApiRequests: Array<{
  body: unknown;
  method: string;
  pathname: string;
  search: string;
}> = [];

function isViewApiUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.hostname === "127.0.0.1" &&
      parsed.pathname.startsWith("/api/views")
    );
  } catch {
    return false;
  }
}

async function parseJsonBody(init?: RequestInit): Promise<unknown> {
  const body = init?.body;
  if (typeof body !== "string") return undefined;
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

function expectViewsAction(
  execution: ScenarioTurnExecution,
  expected: {
    action: string;
    alwaysOnTop?: boolean;
    capability?: string;
    responseText?: string;
    view?: string;
    paramValue?: string;
  },
): string | undefined {
  if (
    expected.responseText !== undefined &&
    execution.responseText !== expected.responseText
  ) {
    return `expected responseText=${JSON.stringify(expected.responseText)}, saw ${JSON.stringify(execution.responseText)}`;
  }
  const action = execution.actionsCalled.find(
    (candidate) => candidate.actionName === "VIEWS",
  );
  if (!action) {
    return `expected VIEWS action, saw ${execution.actionsCalled.map((candidate) => candidate.actionName).join(", ") || "none"}`;
  }
  const params = readParameters(action);
  if (params.action !== expected.action && params.mode !== expected.action) {
    return `expected VIEWS action=${expected.action}, saw ${String(params.action ?? params.mode)}`;
  }
  if (
    expected.view &&
    params.view !== expected.view &&
    params.id !== expected.view
  ) {
    return `expected VIEWS view=${expected.view}, saw ${String(params.view ?? params.id)}`;
  }
  if (expected.capability && params.capability !== expected.capability) {
    return `expected VIEWS capability=${expected.capability}, saw ${String(params.capability)}`;
  }
  if (
    expected.alwaysOnTop !== undefined &&
    params.alwaysOnTop !== expected.alwaysOnTop
  ) {
    return `expected VIEWS alwaysOnTop=${expected.alwaysOnTop}, saw ${String(params.alwaysOnTop)}`;
  }
  if (expected.paramValue) {
    const capabilityParams =
      params.params &&
      typeof params.params === "object" &&
      !Array.isArray(params.params)
        ? (params.params as Record<string, unknown>)
        : {};
    if (capabilityParams.value !== expected.paramValue) {
      return `expected VIEWS params.value=${expected.paramValue}, saw ${String(capabilityParams.value)}`;
    }
  }
  return undefined;
}

export default scenario({
  id: "deterministic-pr-smoke",
  title: "Deterministic PR scenario smoke",
  domain: "scenario-runner",
  tags: ["pr", "deterministic", "zero-cost"],
  isolation: "shared-runtime",
  requires: {
    plugins: ["@elizaos/plugin-app-control"],
  },
  seed: [
    {
      type: "custom",
      name: "stub local view API for deterministic shell actions",
      apply: () => {
        viewApiRequests.length = 0;
        const originalFetch = globalThis.fetch.bind(globalThis);
        globalThis.fetch = (async (
          input: string | URL | Request,
          init?: RequestInit,
        ) => {
          const rawUrl =
            typeof input === "string"
              ? input
              : input instanceof URL
                ? input.toString()
                : input.url;
          if (!isViewApiUrl(rawUrl)) {
            return originalFetch(input as Parameters<typeof fetch>[0], init);
          }

          const url = new URL(rawUrl);
          viewApiRequests.push({
            body: await parseJsonBody(init),
            method: init?.method ?? "GET",
            pathname: url.pathname,
            search: url.search,
          });

          if (url.pathname.endsWith("/interact")) {
            return new Response(
              JSON.stringify({
                ok: true,
                capability: "fill-input",
                value: "Remote Ledger Updated",
              }),
              {
                status: 200,
                headers: { "Content-Type": "application/json" },
              },
            );
          }

          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }) as typeof fetch;
        return undefined;
      },
    },
  ],
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "Deterministic PR Smoke",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "deterministic reply",
      text: "hello deterministic proxy",
      responseIncludesAny: [
        "deterministic-test-response: hello deterministic proxy",
      ],
      assertTurn: (execution) =>
        execution.responseText ===
        "deterministic-test-response: hello deterministic proxy"
          ? undefined
          : `expected exact deterministic reply, saw ${JSON.stringify(execution.responseText)}`,
    },
    {
      kind: "action",
      name: "open view manager",
      text: "Open the view manager",
      actionName: "VIEWS",
      options: { action: "manager" },
      responseIncludesAny: [
        "View Manager",
        "Opened View Manager",
        "Navigated to View Manager",
      ],
      assertTurn: (execution) =>
        expectViewsAction(execution, {
          action: "manager",
          responseText: "Navigated to View Manager.",
        }),
    },
    {
      kind: "action",
      name: "pin remote ledger",
      text: "Pin the remote ledger view as a desktop tab",
      actionName: "VIEWS",
      options: { action: "pin", view: "remote-ledger" },
      responseIncludesAny: ["Pinned", "Requested desktop tab pin"],
      assertTurn: (execution) =>
        expectViewsAction(execution, {
          action: "pin",
          responseText: 'Pinned gui view "remote-ledger" as a desktop tab.',
          view: "remote-ledger",
        }),
    },
    {
      kind: "action",
      name: "open remote ledger window",
      text: "Open the remote ledger view in a separate always on top window",
      actionName: "VIEWS",
      options: { action: "window", alwaysOnTop: true, view: "remote-ledger" },
      responseIncludesAny: ["separate window", "Requested separate window"],
      assertTurn: (execution) =>
        expectViewsAction(execution, {
          action: "window",
          alwaysOnTop: true,
          responseText: 'Opened gui view "remote-ledger" in a separate window.',
          view: "remote-ledger",
        }),
    },
    {
      kind: "action",
      name: "fill remote ledger title",
      text: "Fill the remote ledger view title input with Remote Ledger Updated",
      actionName: "VIEWS",
      options: {
        action: "interact",
        capability: "fill-input",
        params: { name: "view-title", value: "Remote Ledger Updated" },
        view: "remote-ledger",
      },
      responseIncludesAny: [
        "remote-ledger",
        "Interacted with view",
        "Remote Ledger Updated",
      ],
      assertTurn: (execution) =>
        expectViewsAction(execution, {
          action: "interact",
          capability: "fill-input",
          paramValue: "Remote Ledger Updated",
          responseText:
            'Interacted with view "remote-ledger" — capability "fill-input": {"ok":true,"capability":"fill-input","value":"Remote Ledger Updated"}.',
          view: "remote-ledger",
        }),
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      actionName: "VIEWS",
      minCount: 4,
    },
    {
      type: "selectedActionArguments",
      actionName: "VIEWS",
      includesAll: [
        /manager/,
        /pin/,
        /window/,
        /alwaysOnTop/,
        /interact/,
        /remote-ledger/,
        /fill-input/,
      ],
    },
    {
      type: "custom",
      name: "view shell API received exact deterministic requests",
      predicate: () => {
        const expected = [
          {
            body: { path: "/views" },
            method: "POST",
            pathname: "/api/views/__view-manager__/navigate",
            search: "",
          },
          {
            body: { action: "pin-tab", alwaysOnTop: false },
            method: "POST",
            pathname: "/api/views/remote-ledger/navigate",
            search: "",
          },
          {
            body: { action: "open-window", alwaysOnTop: true },
            method: "POST",
            pathname: "/api/views/remote-ledger/navigate",
            search: "",
          },
          {
            body: {
              capability: "fill-input",
              params: { name: "view-title", value: "Remote Ledger Updated" },
              timeoutMs: 5000,
            },
            method: "POST",
            pathname: "/api/views/remote-ledger/interact",
            search: "",
          },
        ];

        const actual = viewApiRequests.map((request) => ({
          body: request.body,
          method: request.method,
          pathname: request.pathname,
          search: request.search,
        }));

        return JSON.stringify(actual) === JSON.stringify(expected)
          ? undefined
          : `expected exact view shell API requests ${JSON.stringify(expected)}, saw ${JSON.stringify(actual)}`;
      },
    },
  ],
});
