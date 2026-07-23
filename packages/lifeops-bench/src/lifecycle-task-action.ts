/**
 * Capture-only TASKS surface for the orchestrator lifecycle benchmark.
 *
 * The corpus contains synthetic targets, so executing the production handler
 * would either fail against missing sessions or launch real coding agents.
 * This wrapper keeps AgentRuntime's native planning and action execution path,
 * but records validated arguments in request-local storage and returns the same
 * neutral no-side-effect result used by the Hermes and OpenClaw bridges.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import type {
  Action,
  ActionParameter,
  ActionResult,
  IAgentRuntime,
  Plugin,
} from "@elizaos/core";
import { ElizaError } from "@elizaos/core";
import { z } from "zod";

const taskPropertySchema = z
  .object({
    type: z.enum(["string", "boolean"]),
    description: z.string().min(1),
    enum: z.array(z.string()).min(1).optional(),
  })
  .strict();

const lifecycleTasksContractSchema = z
  .object({
    type: z.literal("function"),
    function: z
      .object({
        name: z.literal("TASKS"),
        description: z.string().min(1),
        parameters: z
          .object({
            type: z.literal("object"),
            properties: z.record(z.string(), taskPropertySchema),
            required: z.array(z.string()),
            additionalProperties: z.literal(false),
          })
          .strict(),
      })
      .strict(),
    "x-eliza-benchmark": z
      .object({
        mode: z.literal("capture_only"),
        result: z
          .object({
            captured: z.literal(true),
            effect: z.literal("not_executed"),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

export const LIFECYCLE_TASKS_TOOL_CONTRACT = lifecycleTasksContractSchema.parse(
  JSON.parse(
    readFileSync(
      new URL(
        "../../benchmarks/orchestrator_lifecycle/tasks-tool.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ),
);

export const LIFECYCLE_TASK_CONTEXTS = [
  "general",
  "code",
  "automation",
  "agent_internal",
  "connectors",
] as const;

export interface LifecycleCaptureResult {
  captured: true;
  effect: "not_executed";
  sequence: number;
  tool: "TASKS";
}

export interface LifecycleTaskExecution {
  arguments: Record<string, unknown>;
  result: LifecycleCaptureResult;
}

export interface LifecycleTaskToolCall {
  id: string;
  name: "TASKS";
  arguments: Record<string, unknown>;
}

interface LifecycleCaptureStore {
  executions: LifecycleTaskExecution[];
}

const lifecycleCaptureStorage = new AsyncLocalStorage<LifecycleCaptureStore>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function copyJsonValue(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(copyJsonValue);
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, copyJsonValue(child)]),
    );
  }
  throw new TypeError("Lifecycle TASKS arguments must be JSON-serializable");
}

function copyArguments(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw invalidLifecycleTaskArguments("arguments must be an object");
  }
  const parameters = LIFECYCLE_TASKS_TOOL_CONTRACT.function.parameters;
  for (const required of parameters.required) {
    if (!Object.hasOwn(value, required)) {
      throw invalidLifecycleTaskArguments(
        "required field is missing",
        required,
      );
    }
  }
  for (const [key, child] of Object.entries(value)) {
    const property = parameters.properties[key];
    if (!property) {
      throw invalidLifecycleTaskArguments("field is not allowed", key);
    }
    if (typeof child !== property.type) {
      throw invalidLifecycleTaskArguments(
        `field must be ${property.type}`,
        key,
      );
    }
    if (property.enum && !property.enum.includes(child as string)) {
      throw invalidLifecycleTaskArguments("field is outside its enum", key);
    }
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, copyJsonValue(child)]),
  );
}

function invalidLifecycleTaskArguments(
  reason: string,
  field?: string,
): ElizaError {
  return new ElizaError(`Lifecycle TASKS arguments are invalid: ${reason}`, {
    code: "BENCHMARK_LIFECYCLE_TASKS_ARGUMENTS_INVALID",
    context: { reason, ...(field ? { field } : {}) },
    severity: "ephemeral",
  });
}

function actionParameters(): ActionParameter[] {
  const required = new Set(
    LIFECYCLE_TASKS_TOOL_CONTRACT.function.parameters.required,
  );
  return Object.entries(
    LIFECYCLE_TASKS_TOOL_CONTRACT.function.parameters.properties,
  ).map(([name, property]) => ({
    name,
    description: property.description,
    required: required.has(name),
    schema: {
      type: property.type,
      ...(property.enum ? { enum: [...property.enum] } : {}),
    },
  }));
}

function captureResult(sequence: number): LifecycleCaptureResult {
  const base = LIFECYCLE_TASKS_TOOL_CONTRACT["x-eliza-benchmark"].result;
  return {
    captured: base.captured,
    effect: base.effect,
    sequence,
    tool: "TASKS",
  };
}

/** Build the lifecycle plugin without inheriting production side-effect surfaces. */
export function lifecycleCaptureOnlyPlugin(sourcePlugin: Plugin): Plugin {
  const taskActions = (sourcePlugin.actions ?? []).filter(
    (action) => action.name.trim().toUpperCase() === "TASKS",
  );
  if (taskActions.length !== 1) {
    throw new Error(
      `Lifecycle capture plugin requires exactly one production TASKS action; found ${taskActions.length}`,
    );
  }
  return {
    name: "@elizaos/plugin-agent-orchestrator-lifecycle-capture",
    description: "Benchmark-scoped capture-only TASKS planner surface.",
    actions: taskActions.map(lifecycleCaptureOnlyTasksAction),
  };
}

/** Keep dialogue infrastructure while removing non-TASKS planner actions. */
export function retainOnlyLifecycleTaskAction(
  runtime: Pick<IAgentRuntime, "actions" | "unregisterAction">,
): void {
  const taskActions = runtime.actions.filter(
    (action) => action.name.trim().toUpperCase() === "TASKS",
  );
  if (taskActions.length !== 1) {
    throw new Error(
      `Lifecycle runtime requires exactly one TASKS action before pruning; found ${taskActions.length}`,
    );
  }

  for (const action of [...runtime.actions]) {
    if (action === taskActions[0]) continue;
    if (!runtime.unregisterAction(action.name)) {
      throw new Error(
        `Lifecycle runtime failed to unregister non-TASKS action ${action.name}`,
      );
    }
  }
}

/** Restrict the production TASKS action to the shared capture-only contract. */
export function lifecycleCaptureOnlyTasksAction(baseAction: Action): Action {
  if (baseAction.name.trim().toUpperCase() !== "TASKS") {
    throw new Error(
      `Lifecycle capture wrapper expected TASKS, received ${baseAction.name}`,
    );
  }
  return {
    ...baseAction,
    name: "TASKS",
    description: LIFECYCLE_TASKS_TOOL_CONTRACT.function.description,
    descriptionCompressed: LIFECYCLE_TASKS_TOOL_CONTRACT.function.description,
    compressedDescription: LIFECYCLE_TASKS_TOOL_CONTRACT.function.description,
    routingHint: undefined,
    similes: [],
    examples: [],
    tags: ["benchmark:lifecycle", "capture-only"],
    contexts: [...LIFECYCLE_TASK_CONTEXTS],
    contextGate: {},
    roleGate: { minRole: "NONE" },
    connectorAccountPolicy: undefined,
    accountPolicy: undefined,
    subActions: [],
    subPlanner: false,
    parameters: actionParameters(),
    allowAdditionalParameters: false,
    suppressPostActionContinuation: false,
    suppressEarlyReply: false,
    validate: async () => true,
    handler: async (
      _runtime,
      _message,
      _state,
      options,
    ): Promise<ActionResult> => {
      const store = lifecycleCaptureStorage.getStore();
      if (!store) {
        throw new Error(
          "Lifecycle TASKS executed outside the request-scoped capture boundary",
        );
      }
      const parameters = isRecord(options) ? options.parameters : undefined;
      const execution: LifecycleTaskExecution = {
        arguments: copyArguments(parameters),
        result: captureResult(store.executions.length),
      };
      store.executions.push(execution);
      return {
        success: true,
        text: JSON.stringify(execution.result),
        data: { benchmarkCapture: execution.result },
        continueChain: true,
      };
    },
  };
}

/** Run one message turn with concurrency-safe lifecycle action capture. */
export async function runWithLifecycleTaskCapture<T>(
  run: () => Promise<T>,
): Promise<{ result: T; executions: LifecycleTaskExecution[] }> {
  const store: LifecycleCaptureStore = { executions: [] };
  const result = await lifecycleCaptureStorage.run(store, run);
  return { result, executions: store.executions };
}

function actionResultName(result: ActionResult): string {
  const name = result.data?.actionName;
  return typeof name === "string" ? name.trim().toUpperCase() : "";
}

/**
 * Cross-check request-local executions against core's completed action ledger
 * before exposing calls to the Python evaluator.
 */
export function projectLifecycleTaskExecutions(
  executions: readonly LifecycleTaskExecution[],
  actionResults: readonly ActionResult[] | undefined,
): {
  actions: string[];
  params: Record<string, unknown>;
  toolCalls: LifecycleTaskToolCall[];
} {
  const completedTasks = (actionResults ?? []).filter(
    (result) => actionResultName(result) === "TASKS",
  );
  if (completedTasks.length !== executions.length) {
    throw new Error(
      "Lifecycle TASKS capture/action-result count mismatch " +
        `(captured=${executions.length}, completed=${completedTasks.length})`,
    );
  }
  for (const [index, execution] of executions.entries()) {
    const completed = completedTasks[index];
    if (completed?.success !== true) {
      throw new Error(`Lifecycle TASKS action ${index} did not complete`);
    }
    const recordedResult = completed.data?.benchmarkCapture;
    if (JSON.stringify(recordedResult) !== JSON.stringify(execution.result)) {
      throw new Error(`Lifecycle TASKS action ${index} result mismatch`);
    }
  }
  const toolCalls = executions.map((execution, index) => ({
    id: `call_lifecycle_${index}`,
    name: "TASKS" as const,
    arguments: execution.arguments,
  }));
  return {
    actions: toolCalls.map((call) => call.name),
    params: {
      tool_calls: toolCalls,
      lifecycle_results: executions.map((execution) => ({
        name: "TASKS",
        arguments: execution.arguments,
        result: execution.result,
      })),
    },
    toolCalls,
  };
}
