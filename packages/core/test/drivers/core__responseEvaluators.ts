// SPEC.md, "Conformance": spec/core/responseEvaluators.md against the response-handler evaluator registry of AgentRuntime, observed as the evaluators it holds, in order, each by the reference of the object registered
import type { Driver, Options } from "../../gen/core__responseEvaluators.conformance.ts";
import type { ResponseEvaluators } from "../../gen/core__responseEvaluators.ts";
import { AgentRuntime } from "../../src/runtime.vibe";
import type { ResponseHandlerEvaluator } from "../../src/runtime/response-handler-evaluators.vibe";

const runtimes = new Map<string, AgentRuntime>();
const references = new Map<ResponseHandlerEvaluator, number>();

const runtimeOf = (key: string): AgentRuntime => {
  const found = runtimes.get(key);
  if (found) return found;
  const created = new AgentRuntime({});
  runtimes.set(key, created);
  return created;
};

const referenceOf = (evaluator: ResponseHandlerEvaluator): number => {
  const reference = references.get(evaluator);
  if (reference === undefined) throw new Error(`the registry holds an evaluator the driver never registered: ${evaluator.name}`);
  return reference;
};

export const driver: Driver = {
  reset: () => {
    runtimes.clear();
    references.clear();
  },
  dispatch: (key, event) => {
    const runtime = runtimeOf(key);
    if (event.type === "register") {
      const evaluator: ResponseHandlerEvaluator = { name: event.name, shouldRun: () => false, evaluate: () => undefined };
      references.set(evaluator, event.reference);
      runtime.registerResponseHandlerEvaluator(evaluator);
    } else {
      runtime.unregisterResponseHandlerEvaluator(event.normalizedName);
    }
    return "accepted";
  },
  observe: (key): ResponseEvaluators => ({
    entries: runtimeOf(key).responseHandlerEvaluators.map((evaluator) => ({ name: evaluator.name, reference: referenceOf(evaluator) })),
  }),
};

export const options: Options = {};
