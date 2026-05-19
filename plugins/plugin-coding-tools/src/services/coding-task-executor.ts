import crypto from "node:crypto";
import type { Content, IAgentRuntime, Memory, UUID } from "@elizaos/core";

type TaskSpec = {
  id: string;
  description: string;
  type: string;
  metadata?: Record<string, unknown>;
  agentType?: string;
  message?: Memory;
};

type TaskResult = {
  taskId: string;
  success: boolean;
  output?: string;
  artifacts?: Array<{ name: string; path: string; type: string }>;
  error?: string;
  durationMs?: number;
};

type TaskExecutor = {
  readonly type: string;
  readonly description: string;
  canHandle(spec: TaskSpec, runtime: IAgentRuntime): boolean;
  execute(spec: TaskSpec, runtime: IAgentRuntime): Promise<TaskResult>;
  abort(taskId: string): Promise<void>;
};

const CODING_PATTERNS =
  /\b(build|create|make|scaffold|generate|code|implement|develop|fix|debug|refactor|write)\b/i;

type CreateTaskActionLike = {
  name: string;
  validate?: (
    runtime: IAgentRuntime,
    memory: Memory,
    state?: unknown,
  ) => Promise<boolean>;
  handler: (
    runtime: IAgentRuntime,
    memory: Memory,
    state?: unknown,
    options?: { parameters?: Record<string, unknown> },
    callback?: (content: Content) => Promise<Memory[]>,
  ) => Promise<unknown>;
};

function findCreateTaskAction(
  runtime: IAgentRuntime,
): CreateTaskActionLike | null {
  const actions = Array.isArray(runtime.actions)
    ? (runtime.actions as CreateTaskActionLike[])
    : [];
  return (
    actions.find((action) => action.name === "START_CODING_TASK") ??
    actions.find((action) => action.name === "CREATE_TASK") ??
    null
  );
}

function buildSyntheticTaskMemory(
  runtime: IAgentRuntime,
  spec: TaskSpec,
): Memory {
  if (spec.message) {
    return spec.message;
  }

  const roomId = (runtime.agentId || "room-default") as UUID;
  return {
    id: crypto.randomUUID() as UUID,
    entityId: runtime.agentId,
    agentId: runtime.agentId,
    roomId,
    content: {
      text: spec.description,
      agentType: spec.agentType,
    } as Content,
    createdAt: Date.now(),
  };
}

/**
 * Executes coding tasks by delegating to the START_CODING_TASK / CREATE_TASK
 * action registered by the orchestrator plugin.
 */
export class CodingTaskExecutor implements TaskExecutor {
  readonly type = "coding";
  readonly description =
    "Executes coding tasks using the orchestrator task contract";

  canHandle(spec: TaskSpec, runtime: IAgentRuntime): boolean {
    if (!findCreateTaskAction(runtime)) return false;

    // Explicit type match
    if (spec.type === "coding") return true;

    // Heuristic: description matches coding-related verbs
    return CODING_PATTERNS.test(spec.description);
  }

  async execute(spec: TaskSpec, runtime: IAgentRuntime): Promise<TaskResult> {
    const action = findCreateTaskAction(runtime);
    const startTime = Date.now();

    if (!action) {
      return {
        taskId: spec.id,
        success: false,
        error: "Task orchestrator is not available",
      };
    }

    const memory = buildSyntheticTaskMemory(runtime, spec);
    const callbackLines: string[] = [];
    const callback = async (content: Content): Promise<Memory[]> => {
      if (typeof content.text === "string" && content.text.trim().length > 0) {
        callbackLines.push(content.text);
      }
      return [];
    };

    try {
      if (action.validate) {
        const valid = await action.validate(runtime, memory, undefined);
        if (!valid) {
          return {
            taskId: spec.id,
            success: false,
            error: "Task orchestrator rejected the coding task request",
            durationMs: Date.now() - startTime,
          };
        }
      }

      const result = (await action.handler(
        runtime,
        memory,
        undefined,
        {
          parameters: {
            task: spec.description,
            ...(spec.agentType ? { agentType: spec.agentType } : {}),
          },
        },
        callback,
      )) as
        | {
            success?: boolean;
            text?: string;
            data?: {
              agents?: Array<{ sessionId?: string }>;
            };
            error?: string;
          }
        | undefined;

      const sessionId = result?.data?.agents?.[0]?.sessionId;
      const output = sessionId || result?.text || callbackLines.join("\n");
      if (result?.success === false) {
        return {
          taskId: spec.id,
          success: false,
          error: result.error || result.text || "Task creation failed",
          durationMs: Date.now() - startTime,
        };
      }

      return {
        taskId: spec.id,
        success: true,
        output,
        durationMs: Date.now() - startTime,
      };
    } catch (error) {
      return {
        taskId: spec.id,
        success: false,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startTime,
      };
    }
  }

  async abort(_taskId: string): Promise<void> {
    // Abort is handled through the existing PTY session stop mechanism.
  }
}
