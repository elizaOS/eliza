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

function expectViewsAction(
  execution: ScenarioTurnExecution,
  expected: {
    action: string;
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
      responseIncludesAny: ["hello deterministic proxy", "On it."],
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
          responseText: "Opened View Manager at /views.",
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
          responseText: 'Requested desktop tab pin for gui view "remote-ledger".',
          view: "remote-ledger",
        }),
    },
    {
      kind: "action",
      name: "open remote ledger window",
      text: "Open the remote ledger view in a separate window",
      actionName: "VIEWS",
      options: { action: "window", view: "remote-ledger" },
      responseIncludesAny: ["separate window", "Requested separate window"],
      assertTurn: (execution) =>
        expectViewsAction(execution, {
          action: "window",
          responseText: 'Requested separate window for gui view "remote-ledger".',
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
        "Failed to interact",
        "did not respond",
      ],
      assertTurn: (execution) =>
        expectViewsAction(execution, {
          action: "interact",
          capability: "fill-input",
          paramValue: "Remote Ledger Updated",
          responseText:
            'Failed to interact with view "remote-ledger": network error.',
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
        /interact/,
        /remote-ledger/,
        /fill-input/,
      ],
    },
  ],
});
