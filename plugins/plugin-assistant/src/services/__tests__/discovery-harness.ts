/** One DISCOVER_ACTIONS action over a catalog, recording what each call loads. */

import type {
  Action,
  ActionParameters,
  IAgentRuntime,
  Memory,
} from "@elizaos/core";
import { createPlannerToolDiscoveryAction } from "../message/tool-discovery.ts";

export function discoveryHarness(
  catalog: Action[],
  turn: Memory,
  options: Omit<
    NonNullable<Parameters<typeof createPlannerToolDiscoveryAction>[3]>,
    "exposedToolNames"
  > & {
    /** The planner's tool list; a load appends the tools it adds. */
    exposed?: string[];
  } = {},
) {
  const { exposed, ...discoveryOptions } = options;
  const loads: string[][] = [];
  const discovery = createPlannerToolDiscoveryAction(
    catalog,
    (actions) => {
      loads.push(actions.map((action) => action.name));
      for (const action of actions)
        if (exposed && !exposed.includes(action.name))
          exposed.push(action.name);
    },
    async () => catalog,
    {
      ...discoveryOptions,
      ...(exposed && { exposedToolNames: () => [...exposed] }),
    },
  );
  return {
    loads,
    call: (parameters: ActionParameters) =>
      discovery.handler?.({} as IAgentRuntime, turn, undefined, { parameters }),
  };
}
