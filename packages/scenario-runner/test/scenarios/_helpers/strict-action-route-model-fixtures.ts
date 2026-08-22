/** Builds data-only scenario manifests for the production two-stage action-routing loop. */

import type { ScenarioModelFixture } from "@elizaos/scenario-runner/schema";

export type StrictScenarioActionRoute = {
  actionName: string;
  args: Record<string, unknown>;
  contextIds?: readonly string[];
  input: string;
  messageToUser?: string;
};

function actionSlug(actionName: string): string {
  return actionName.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Match the authored text only inside the final user-message prompt segment. */
export function latestScenarioInputPattern(input: string): string {
  const escaped = escapeRegExp(input);
  return `message:user:\\n(?:(?!message:user:\\n)[\\s\\S])*${escaped}(?:(?!message:user:\\n)[\\s\\S])*$`;
}

/** Expand an exact user input into the router and planner calls it must consume. */
export function strictActionRouteModelFixtures(
  routes: readonly StrictScenarioActionRoute[],
): ScenarioModelFixture[] {
  return routes.flatMap((route) => {
    const slug = actionSlug(route.actionName);
    const replyText = route.messageToUser ?? "On it.";
    return [
      {
        name: `route-${slug}-stage1-${route.input}`,
        match: {
          modelType: "RESPONSE_HANDLER",
          input: { pattern: latestScenarioInputPattern(route.input) },
        },
        response: {
          json: {
            contexts: [...(route.contextIds ?? ["general"])],
            intents: [route.input.toLowerCase()],
            replyText,
            threadOps: [],
            candidateActionNames: [route.actionName],
          },
        },
      },
      {
        name: `route-${slug}-planner-${route.input}`,
        match: {
          modelType: "ACTION_PLANNER",
          input: { pattern: latestScenarioInputPattern(route.input) },
        },
        response: {
          json: {
            text: "",
            thought: `Call ${route.actionName} for ${route.input}.`,
            messageToUser: replyText,
            completed: true,
            finishReason: "tool-calls",
            toolCalls: [
              {
                id: `call-${slug}`,
                name: route.actionName,
                type: "function",
                arguments: route.args,
              },
            ],
          },
        },
      },
    ] satisfies ScenarioModelFixture[];
  });
}
