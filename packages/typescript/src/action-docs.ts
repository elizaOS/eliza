import { allActionDocs, allEvaluatorDocs } from "./generated/action-docs.ts";
import type {
  Action,
  ActionExample,
  ActionParameter,
  EvaluationExample,
  Evaluator,
} from "./types/index.ts";

type ActionDocByName = Record<string, (typeof allActionDocs)[number]>;

const coreActionDocByName: ActionDocByName =
  allActionDocs.reduce<ActionDocByName>((acc, doc) => {
    acc[doc.name] = doc;
    return acc;
  }, {});

function toActionParameter(
  param: NonNullable<(typeof allActionDocs)[number]["parameters"]>[number],
): ActionParameter {
  return {
    name: param.name,
    description: param.description,
    required: param.required,
    schema: {
      ...param.schema,
      enumValues: param.schema.enum,
    },
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
      : (doc.parameters ?? []).map(toActionParameter);

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

export function withCanonicalActionDocsAll(
  actions: readonly Action[],
): Action[] {
  return actions.map(withCanonicalActionDocs);
}

type EvaluatorDocByName = Record<string, (typeof allEvaluatorDocs)[number]>;

const coreEvaluatorDocByName: EvaluatorDocByName =
  allEvaluatorDocs.reduce<EvaluatorDocByName>((acc, doc) => {
    acc[doc.name] = doc;
    return acc;
  }, {});

function toEvaluationExample(
  ex: NonNullable<(typeof allEvaluatorDocs)[number]["examples"]>[number],
): EvaluationExample {
  const messages: ActionExample[] = (ex.messages ?? []).map((m) => ({
    name: m.name,
    content: {
      text: m.content.text,
      type: m.content.type,
    },
  }));

  return {
    prompt: ex.prompt,
    messages,
    outcome: ex.outcome,
  };
}

/**
 * Merge canonical docs (description/similes/examples) into an evaluator definition.
 *
 * This is additive and intentionally conservative:
 * - does not overwrite an existing evaluator.description
 * - does not overwrite existing evaluator.similes
 * - does not overwrite existing evaluator.examples (when non-empty)
 */
export function withCanonicalEvaluatorDocs(evaluator: Evaluator): Evaluator {
  const doc = coreEvaluatorDocByName[evaluator.name];
  if (!doc) return evaluator;

  const examples =
    evaluator.examples && evaluator.examples.length > 0
      ? evaluator.examples
      : (doc.examples ?? []).map(toEvaluationExample);

  return {
    ...evaluator,
    description: evaluator.description || doc.description,
    similes:
      evaluator.similes && evaluator.similes.length > 0
        ? evaluator.similes
        : doc.similes
          ? [...doc.similes]
          : undefined,
    examples,
  };
}

export function withCanonicalEvaluatorDocsAll(
  evaluators: readonly Evaluator[],
): Evaluator[] {
  return evaluators.map(withCanonicalEvaluatorDocs);
}
