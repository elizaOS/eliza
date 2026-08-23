/**
 * Keyless end-to-end coverage for same-turn deferred action discovery.
 * A strict planner fixture inspects the real tool schemas on every iteration,
 * so the scenario fails if the target is eager, cannot be hydrated after
 * search, or if an unrelated sibling is expanded with it.
 */
import {
  type Action,
  type DeterministicModelCall,
  ModelType,
} from "@elizaos/core";
import { matchesScenarioInput } from "@elizaos/core/testing";
import type { ScenarioTurnExecution } from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";

const input = "Get the thing I mentioned from the other system.";
const targetActionName = "SCENARIO_ARCHIVE_LOOKUP";
const siblingActionName = "SCENARIO_ARCHIVE_DELETE";
const parentActionName = "SCENARIO_ARCHIVE";

type RuntimeWithFixturesAndActions = {
  actions: Action[];
  scenarioModelFixtures?: {
    register: (...fixtures: Array<Record<string, unknown>>) => void;
  };
};

const lookupAction: Action = {
  name: targetActionName,
  description:
    "Retrieve the sealed Atlas record from the cold archive and return its identifier.",
  descriptionCompressed: "Retrieve a sealed cold-archive record.",
  similes: ["ATLAS_VAULT_LOOKUP_ZXQ"],
  contexts: ["archive"],
  examples: [],
  parameters: [],
  validate: async () => true,
  handler: async () => ({
    success: true,
    text: "Atlas record archive://sealed/atlas-7",
    userFacingText: "Retrieved Atlas record archive://sealed/atlas-7.",
    data: { recordId: "archive://sealed/atlas-7" },
  }),
};

const parentAction: Action = {
  name: parentActionName,
  description: "Route requests for the scenario cold archive.",
  descriptionCompressed: "Route cold-archive requests.",
  contexts: ["archive"],
  subActions: [targetActionName, siblingActionName],
  examples: [],
  parameters: [],
  validate: async () => true,
  handler: async () => ({
    success: false,
    text: "The parent should route or discover a concrete archive operation.",
  }),
};

const siblingAction: Action = {
  name: siblingActionName,
  description:
    "Permanently delete a cold-archive record after explicit confirmation.",
  descriptionCompressed: "Delete a cold-archive record.",
  contexts: ["archive"],
  tags: ["capability:delete"],
  examples: [],
  parameters: [],
  validate: async () => true,
  handler: async () => ({
    success: false,
    text: "This sibling action must remain deferred and must never execute.",
  }),
};

function toolNames(call: DeterministicModelCall): Set<string> {
  return new Set(call.toolNames);
}

export default scenario({
  id: "deterministic-capability-discovery",
  lane: "pr-deterministic",
  title: "Deferred action is discovered and hydrated in the same turn",
  domain: "core-runtime",
  tags: ["pr", "deterministic", "zero-cost", "tools", "discovery"],
  isolation: "shared-runtime",
  seed: [
    {
      type: "custom",
      name: "register deferred archive actions and strict planner fixtures",
      apply: (ctx) => {
        const runtime = ctx.runtime as RuntimeWithFixturesAndActions;
        runtime.actions.push(parentAction, lookupAction, siblingAction);
        runtime.scenarioModelFixtures?.register(
          {
            name: "capability-discovery-stage1",
            match: {
              modelType: ModelType.RESPONSE_HANDLER,
              input: matchesScenarioInput(input),
              toolName: "HANDLE_RESPONSE",
            },
            response: {
              shouldRespond: "RESPOND",
              contexts: ["general"],
              intents: ["continue an underspecified request in another system"],
              replyText: "I will find the archive capability.",
              candidateActionNames: [],
              facts: [],
              relationships: [],
              addressedTo: [],
              emotion: "focused",
            },
            times: 1,
          },
          {
            name: "capability-discovery-planner",
            match: (call: DeterministicModelCall) =>
              call.modelType === ModelType.ACTION_PLANNER &&
              call.latestUserText.includes(input),
            resolve: (call: DeterministicModelCall) => {
              const visible = toolNames(call);
              if (!visible.has("DISCOVER_CAPABILITIES")) {
                throw new Error(
                  "DISCOVER_CAPABILITIES must remain available on every tiered planner iteration",
                );
              }
              if (visible.size > 24) {
                throw new Error(
                  `initial capability surface is not compact: saw ${visible.size} tools`,
                );
              }
              if (visible.has(siblingActionName)) {
                throw new Error(
                  `${siblingActionName} was expanded even though only the lookup action was loaded`,
                );
              }
              if (!visible.has(targetActionName)) {
                return {
                  text: "Searching the authorized capability catalog.",
                  thought: "The archive lookup schema is deferred.",
                  finishReason: "tool-calls",
                  toolCalls: [
                    {
                      id: "discover-archive-lookup",
                      name: "DISCOVER_CAPABILITIES",
                      type: "function",
                      arguments: {
                        operation: "search",
                        query: "ATLAS_VAULT_LOOKUP_ZXQ",
                        kinds: ["action"],
                        limit: 1,
                      },
                    },
                  ],
                };
              }
              return {
                text: "",
                thought: "The requested lookup schema is now available.",
                messageToUser: "Retrieved the sealed Atlas record.",
                completed: true,
                finishReason: "tool-calls",
                toolCalls: [
                  {
                    id: "execute-archive-lookup",
                    name: targetActionName,
                    type: "function",
                    arguments: {},
                  },
                ],
              };
            },
            times: 2,
          },
          {
            name: "capability-discovery-post-turn-evaluation",
            match: (call: DeterministicModelCall) =>
              call.modelType === ModelType.TEXT_SMALL &&
              call.latestUserText.includes(input),
            response: {
              factMemory: { ops: [] },
              preferences: { ops: [] },
              relationships: { relationships: [] },
              identities: { identities: [] },
              success: {
                completed: true,
                reason: "The archive lookup completed successfully.",
              },
              ftu_goal_discovery: {
                goalFound: false,
                goal: "",
                confidence: 0,
              },
              skillProposal: {
                extract: false,
                reason: "This one-off archive lookup is not a reusable skill.",
              },
            },
            times: 1,
          },
        );
        return undefined;
      },
    },
  ],
  rooms: [
    {
      id: "main",
      source: "client_chat",
      title: "Capability Discovery",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "planner searches, hydrates, and executes only the requested action",
      text: input,
      expectedActions: [targetActionName],
      forbiddenActions: [siblingActionName],
      responseIncludesAny: ["Atlas", "archive://sealed/atlas-7"],
      assertTurn: (execution: ScenarioTurnExecution) => {
        const lookup = execution.actionsCalled.find(
          (action) => action.actionName === targetActionName,
        );
        return lookup?.result?.success === true
          ? undefined
          : `expected successful ${targetActionName}, saw ${JSON.stringify(execution.actionsCalled)}`;
      },
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      name: "deferred lookup executed exactly once",
      actionName: targetActionName,
      status: "success",
      minCount: 1,
    },
  ],
});
