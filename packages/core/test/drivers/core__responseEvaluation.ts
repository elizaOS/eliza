// spec/core/responseEvaluation.md, "Story: Register each named response evaluator once"; spec/core/responseEvaluation.md, "Duplicate registration preserves the original evaluator identity"; spec/core/responseEvaluation.md, "Story: Apply response evaluator decisions in priority order"; spec/core/responseEvaluation.md, "Each candidate checks eligibility before evaluating its patch"; spec/core/responseEvaluation.md, "Invalid tool choices and scope replacements reject the entire patch"; spec/core/responseEvaluation.md, "Applied patches retain exact ordering and context evidence"
import type { Driver, Options } from "../../gen/core__responseEvaluation.conformance.ts";
import type {
  EvaluationError,
  EvaluationPhase,
  NamedValue,
  PatchChange,
  PatchTrace,
  RegisteredEvaluator,
  ResponseEvaluation,
  ResponsePatch,
  ResponsePlan,
} from "../../gen/core__responseEvaluation.ts";
import { AgentRuntime } from "../../src/runtime.vibe";
import type { ContextProviderEvent } from "../../src/runtime/context-object.vibe";
import {
  type ResponseHandlerEvaluationRunResult,
  type ResponseHandlerEvaluator,
  type ResponseHandlerPatch,
  runResponseHandlerEvaluatorsPromise,
} from "../../src/runtime/response-handler-evaluators.vibe";
import { TurnAbortedError } from "../../src/runtime/turn-aborted-error.vibe";
import type { MessageHandlerAction, MessageHandlerPlan, MessageHandlerResult } from "../../src/types/components.vibe";
import type { ContextDefinition } from "../../src/types/contexts.vibe";
import type { Memory } from "../../src/types/memory.vibe";
import type { State } from "../../src/types/state.vibe";

interface Finished {
  active: string[];
  traces: PatchTrace[];
  candidateAdditions: NamedValue[];
  candidatesCleared: boolean;
  contextualSources: string[];
}

interface Observed {
  phase: EvaluationPhase;
  registered: RegisteredEvaluator[];
  plan: ResponsePlan;
  invalidatedFields: string[];
  errors: EvaluationError[];
  cancellation: string;
  finished: Finished | null;
}

interface Waiting {
  phase: "AwaitEligibility" | "AwaitEvaluation";
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

type Ended = { result: ResponseHandlerEvaluationRunResult } | { cancellation: string };

interface Run {
  runtime: AgentRuntime;
  evaluators: Map<string, ResponseHandlerEvaluator>;
  registrations: Map<ResponseHandlerEvaluator, RegisteredEvaluator>;
  handler: MessageHandlerResult;
  waiting?: Waiting;
  invalidated?: ReadonlySet<string>;
  ended?: Ended;
  failure?: Error;
  wake?: () => void;
}

const runs = new Map<string, Run>();

const runOf = (key: string): Run => {
  const found = runs.get(key);
  if (found) return found;
  const created: Run = {
    runtime: new AgentRuntime({}),
    evaluators: new Map(),
    registrations: new Map(),
    handler: { processMessage: "" as MessageHandlerAction, plan: { contexts: [] }, thought: "" },
  };
  runs.set(key, created);
  return created;
};

const waitFor = (run: Run, phase: Waiting["phase"]) =>
  new Promise((resolve, reject) => {
    run.waiting = { phase, resolve, reject };
    run.wake?.();
  });

const evaluatorOf = (run: Run, registration: RegisteredEvaluator): ResponseHandlerEvaluator => {
  const identity = JSON.stringify(registration);
  const found = run.evaluators.get(identity);
  if (found) return found;
  const created: ResponseHandlerEvaluator = {
    name: registration.name,
    priority: registration.priority,
    deterministicActions: registration.declaredTools,
    shouldRun: (context) => {
      run.invalidated = context.invalidatedScopeFields;
      return waitFor(run, "AwaitEligibility") as Promise<boolean>;
    },
    evaluate: () => waitFor(run, "AwaitEvaluation") as Promise<ResponseHandlerPatch | undefined>,
  };
  run.evaluators.set(identity, created);
  run.registrations.set(created, registration);
  return created;
};

const registrationOf = (run: Run, evaluator: ResponseHandlerEvaluator): RegisteredEvaluator => {
  const registration = run.registrations.get(evaluator);
  if (!registration) throw new Error(`the registry holds an evaluator the driver never registered: ${evaluator.name}`);
  return registration;
};

const text = (value: unknown): string => (typeof value === "string" ? value : JSON.stringify(value) ?? "");

const named = (values: readonly string[] | undefined): NamedValue[] =>
  (values ?? []).map((value) => ({ key: value.toLowerCase(), value }));

const handlerPlan = (plan: ResponsePlan): MessageHandlerPlan => {
  const opaque: Record<string, string | string[]> = {
    ...Object.fromEntries(plan.extensions.map(({ key, value }): [string, string] => [key, value])),
    ...(plan.replyStatus ? { replyEffectStatus: plan.replyStatus } : {}),
    ...(plan.evidencePresent ? { requiredToolEvidence: plan.requiredEvidence } : {}),
    ...(plan.budgetPresent ? { requiredToolMissBudget: plan.missBudget } : {}),
    ...(plan.sourceContext ? { sourceContext: plan.sourceContext } : {}),
    ...(plan.priorReceipts.length ? { effectReceipts: [...plan.priorReceipts] } : {}),
  };
  const typed: MessageHandlerPlan = {
    contexts: [...plan.contexts],
    ...(plan.requiresTool ? { requiresTool: true } : {}),
    ...(plan.candidateField ? { candidateActions: plan.candidates.map(({ value }) => value) } : {}),
    ...(plan.parentField ? { parentActionHints: plan.parentHints.map(({ value }) => value) } : {}),
    ...(plan.slices.length ? { contextSlices: plan.slices.map(({ value }) => value) } : {}),
    ...(plan.replyField ? { reply: plan.reply } : {}),
    ...(plan.intents.length ? { intents: [...plan.intents] } : {}),
    ...(plan.toolName ? { deterministicToolCall: { name: plan.toolName, params: { text: plan.toolParams } } } : {}),
  };
  return Object.assign(typed, opaque);
};

const specifiedPlan = ({ processMessage, plan }: MessageHandlerResult): ResponsePlan => {
  const {
    contexts,
    reply,
    replyEffectStatus,
    requiresTool,
    contextSlices,
    candidateActions,
    intents,
    parentActionHints,
    requiredToolMissBudget,
    requiredToolEvidence,
    deterministicToolCall,
    sourceContext,
    effectReceipts,
    ...extensions
  } = plan;
  return {
    process: processMessage,
    requiresTool: requiresTool ?? false,
    replyStatus: replyEffectStatus ?? "",
    contexts: [...contexts],
    candidates: named(candidateActions),
    candidateField: candidateActions !== undefined,
    parentHints: named(parentActionHints),
    parentField: parentActionHints !== undefined,
    slices: named(contextSlices),
    reply: reply ?? "",
    replyField: reply !== undefined,
    intents: intents ?? [],
    extensions: Object.entries(extensions).map(([key, value]) => ({ key, value: text(value) })),
    toolName: deterministicToolCall?.name ?? "",
    toolParams: text(deterministicToolCall?.params?.text ?? ""),
    evidencePresent: requiredToolEvidence !== undefined,
    requiredEvidence: text(requiredToolEvidence ?? ""),
    budgetPresent: requiredToolMissBudget !== undefined,
    missBudget: text(requiredToolMissBudget ?? ""),
    sourceContext: text(sourceContext ?? ""),
    priorReceipts: Array.isArray(effectReceipts) ? effectReceipts.map(text) : [],
  };
};

const contextSource = (id: string): ContextProviderEvent => ({ id, type: "provider", name: id });

const handlerPatch = (patch: ResponsePatch): ResponseHandlerPatch => ({
  ...(patch.replaceScope
    ? {
      replaceIntentScope: {
        intents: patch.intentShapeValid ? patch.intents : [...patch.intents, ""],
        invalidateFields: patch.invalidations.map(({ name }) => name),
      },
    }
    : {}),
  ...(patch.process ? { processMessage: patch.process as MessageHandlerAction } : {}),
  ...(patch.changeRequiresTool ? { requiresTool: patch.requiresTool } : {}),
  ...(patch.nonAppliedReply ? { replyEffectStatus: "non_applied" as const } : {}),
  ...(patch.setContexts ? { setContexts: patch.contexts } : {}),
  ...(patch.addContexts ? { addContexts: patch.contextAdditions } : {}),
  ...(patch.clearCandidates ? { clearCandidateActions: true } : {}),
  ...(patch.addCandidates ? { addCandidateActions: patch.candidates.map(({ value }) => value) } : {}),
  ...(patch.clearParents ? { clearParentActionHints: true } : {}),
  ...(patch.addParents ? { addParentActionHints: patch.parents.map(({ value }) => value) } : {}),
  ...(patch.addSlices ? { addContextSlices: patch.slices.map(({ value }) => value) } : {}),
  ...(patch.toolName ? { deterministicToolCall: { name: patch.toolName, params: { text: patch.toolParams } } } : {}),
  ...(patch.clearReply ? { clearReply: true } : {}),
  ...(patch.setReply ? { reply: patch.reply } : {}),
  ...(patch.contextSources.length ? { contextSources: patch.contextSources.map(contextSource) } : {}),
  ...(patch.debug.length ? { debug: patch.debug.map(({ value }) => value) } : {}),
});

const invalidationPrefix = "intentField:invalidate:";

const change = (text: string): PatchChange =>
  text.startsWith(invalidationPrefix)
    ? { operation: "intentField:invalidate", fieldName: text.slice(invalidationPrefix.length) }
    : { operation: text, fieldName: "" };

const finished = (result: ResponseHandlerEvaluationRunResult): Finished => ({
  active: result.activeEvaluators,
  traces: result.appliedPatches.map(({ evaluatorName, changed, debug }) => ({
    name: evaluatorName,
    changed: changed.map(change),
    debug: named(debug),
  })),
  candidateAdditions: named(result.candidateActionsAddedByEvaluators),
  candidatesCleared: result.candidateActionsClearedByEvaluators,
  contextualSources: (result.contextSources ?? []).map(({ id }) => id),
});

const advance = (run: Run, act: () => void) =>
  new Promise<void>((resolve) => {
    run.waiting = undefined;
    run.wake = resolve;
    act();
  }).then(() => {
    if (run.failure !== undefined) throw run.failure;
    return "accepted" as const;
  });

const start = (run: Run, explicit: RegisteredEvaluator[], plan: ResponsePlan, available: string[]) => {
  run.handler = { processMessage: plan.process as MessageHandlerAction, plan: handlerPlan(plan), thought: "" };
  const finish = (ended: Ended) => {
    run.ended = ended;
    run.wake?.();
  };
  void runResponseHandlerEvaluatorsPromise({
    runtime: run.runtime,
    message: {} as Memory,
    state: {} as State,
    messageHandler: run.handler,
    availableContexts: available.map((id): ContextDefinition => ({ id })),
    evaluators: explicit.map((registration) => evaluatorOf(run, registration)),
  }).then(
    (result) => finish({ result }),
    (error: unknown) => {
      if (error instanceof TurnAbortedError) finish({ cancellation: error.reason });
      else {
        run.failure = error instanceof Error ? error : new Error("the evaluator run failed", { cause: error });
        run.wake?.();
      }
    },
  );
};

const phaseOf = (run: Run): EvaluationPhase => {
  if (run.ended) return "result" in run.ended ? "RunFinished" : "RunCancelled";
  return run.waiting?.phase ?? "RunIdle";
};

const reportedErrors = (run: Run): EvaluationError[] =>
  run.runtime
    .getRecentReportedErrors()
    .filter(({ scope }) => scope === "ResponseHandlerEvaluator.evaluate")
    .map(({ code, message, context }) => ({
      name: text(context?.evaluator),
      message: code.startsWith("RESPONSE_HANDLER_") ? code : message,
    }));

export const driver: Driver<Observed> = {
  reset: () => {
    runs.clear();
  },
  dispatch: (key, event) => {
    const run = runOf(key);
    if (event.type === "register") {
      run.runtime.registerResponseHandlerEvaluator(evaluatorOf(run, event.registration));
      return "accepted";
    }
    if (event.type === "unregister") {
      run.runtime.unregisterResponseHandlerEvaluator(event.normalizedName);
      return "accepted";
    }
    if (event.type === "start") {
      if (phaseOf(run) !== "RunIdle") return "refused";
      return advance(run, () => start(run, event.explicit, event.plan, event.available));
    }
    const waiting = run.waiting;
    if (event.type === "settleEligibility") {
      if (waiting?.phase !== "AwaitEligibility") return "refused";
      const { outcome, eligible, errorText } = event.decision;
      return advance(run, () => {
        if (outcome === "CallbackCancelled") waiting.reject(new TurnAbortedError(errorText));
        else if (outcome === "CallbackFailed") waiting.reject(new Error(errorText));
        else waiting.resolve(eligible);
      });
    }
    if (waiting?.phase !== "AwaitEvaluation") return "refused";
    const { outcome, patch, errorText } = event.receipt;
    return advance(run, () => {
      if (outcome === "CallbackCancelled") waiting.reject(new TurnAbortedError(errorText));
      else if (outcome === "CallbackFailed") waiting.reject(new Error(errorText));
      else waiting.resolve(patch.provided ? handlerPatch(patch) : undefined);
    });
  },
  observe: (key) => {
    const run = runOf(key);
    if (run.failure !== undefined) throw run.failure;
    const ended = run.ended;
    return {
      phase: phaseOf(run),
      registered: run.runtime.responseHandlerEvaluators.map((evaluator) => registrationOf(run, evaluator)),
      plan: specifiedPlan(run.handler),
      invalidatedFields: [...(run.invalidated ?? [])],
      errors: reportedErrors(run),
      cancellation: ended && "cancellation" in ended ? ended.cancellation : "",
      finished: ended && "result" in ended ? finished(ended.result) : null,
    };
  },
};

export const options: Options<Observed> = {
  view: (state: ResponseEvaluation) => ({
    phase: state.phase,
    registered: state.registered,
    plan: state.plan,
    invalidatedFields: state.invalidatedFields,
    errors: state.errors,
    cancellation: state.cancellation,
    finished: state.phase === "RunFinished"
      ? {
        active: state.active,
        traces: state.traces,
        candidateAdditions: state.candidateAdditions,
        candidatesCleared: state.candidatesCleared,
        contextualSources: state.contextualSources,
      }
      : null,
  }),
};
