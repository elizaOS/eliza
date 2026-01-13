import { allActionDocs } from "./generated/action-docs.ts";
import type { Action, ActionParameter } from "./types/index.ts";

type ActionDocByName = Record<string, (typeof allActionDocs)[number]>;

const coreActionDocByName: ActionDocByName = allActionDocs.reduce<ActionDocByName>(
  (acc, doc) => {
    acc[doc.name] = doc;
    return acc;
  },
  {},
);

function toActionParameter(
  param: (typeof allActionDocs)[number]["parameters"][number],
): ActionParameter {
  return {
    name: param.name,
    description: param.description,
    required: param.required,
    schema: param.schema,
    examples: param.examples ? [...param.examples] : undefined,
  };
}

/**
 * Merge canonical docs (description/similes/parameters) into an action definition.
 *
 * This is additive and intentionally conservative:
 * - does not overwrite an existing action.description
 * - does not overwrite existing action.similes
 * - does not overwrite existing action.parameters
 */
export function withCanonicalActionDocs(action: Action): Action {
  const doc = coreActionDocByName[action.name];
  if (!doc) return action;

  const parameters =
    action.parameters && action.parameters.length > 0
      ? action.parameters
      : doc.parameters.map(toActionParameter);

  return {
    ...action,
    description: action.description || doc.description,
    similes:
      action.similes && action.similes.length > 0
        ? action.similes
        : doc.similes
          ? [...doc.similes]
          : undefined,
    parameters,
  };
}

export function withCanonicalActionDocsAll(actions: readonly Action[]): Action[] {
  return actions.map(withCanonicalActionDocs);
}

