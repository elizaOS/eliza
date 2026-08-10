/**
 * TASKMARKET_CREATE_TASK — delegate work to the TaskMarket worker market by
 * posting a task. This is the only action in the plugin that moves money:
 * `POST /tasks` escrows the reward in real USDC on Base at creation time.
 *
 * It is therefore gated four independent ways, and all four must pass:
 *
 * 1. **Role.** `roleGate: { minRole: "OWNER" }` — in a shared agent, a member
 *    or guest cannot reach a spend path at all. Matches how the sibling
 *    money-moving `plugin-wallet` gates its own actions.
 * 2. **Off by default.** `TASKMARKET_ALLOW_TASK_CREATION` must be explicitly
 *    enabled by the integrator. Unset, the plugin is a read-only surface.
 * 3. **Bounded per call.** `TASKMARKET_MAX_TASK_REWARD_USDC` (default 1 USDC,
 *    hard ceiling 50) is enforced by *refusing* an over-budget request rather
 *    than silently trimming the reward down to the cap — a trimmed spend is a
 *    spend the user never approved.
 * 4. **Two-turn user confirmation.** The core `gateDestructiveConfirmation`
 *    helper previews the exact task and reward, then requires a yes-shaped
 *    reply from the real `Memory` on the following turn. No planner-authored
 *    `confirmed` parameter exists: core's own contract states an LLM
 *    confirmation flag must never authorize a destructive operation, and the
 *    public task board is untrusted input — another task's description, a
 *    fetched page or a document can all contain text asking the agent to post
 *    a task, and none of those is a user.
 *
 * The confirmation is bound to the exact previewed spend: the pending key is
 * derived from the description and the normalized atomic reward, so a changed
 * task or amount cannot be settled by a stale approval, and the stashed
 * metadata is re-checked before the POST. Records expire after five minutes.
 *
 * Escrow release is deliberately not exposed. There is no accept-submission or
 * withdraw action anywhere in this plugin; settlement stays with the human.
 */
import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { gateDestructiveConfirmation } from "@elizaos/core";
import {
  createTask,
  TaskMarketApiError,
  TaskMarketResponseError,
} from "../lib/client.ts";
import {
  failureActionResult,
  readNumberParam,
  readStringParam,
  resolveTaskMarketConfig,
  successActionResult,
  TASKMARKET_CONTEXTS,
  usdcToAtomic,
} from "../types.ts";

const MAX_DESCRIPTION_CHARS = 10_000;
const MIN_DESCRIPTION_CHARS = 20;
const MAX_TAGS = 10;
const DEFAULT_DURATION_HOURS = 72;
const MAX_DURATION_HOURS = 24 * 30;
const CONFIRMATION_TTL_MS = 5 * 60_000;

function parseTags(raw: string | undefined): string[] {
  if (!raw) return ["agent"];
  const tags = raw
    .split(",")
    .map((tag) => tag.trim().toLowerCase())
    .filter((tag) => tag.length > 0);
  return tags.length > 0 ? tags.slice(0, MAX_TAGS) : ["agent"];
}

/**
 * Stable fingerprint of the exact spend being confirmed. Two different tasks,
 * or the same task at a different reward, produce different keys — so an
 * approval can only ever settle the operation it was shown.
 */
function spendFingerprint(description: string, rewardAtomic: string): string {
  let hash = 0;
  for (const char of description) {
    hash = (hash * 31 + char.charCodeAt(0)) | 0;
  }
  return `${rewardAtomic}:${(hash >>> 0).toString(36)}`;
}

export const taskMarketCreateTaskAction: Action = {
  name: "TASKMARKET_CREATE_TASK",
  contexts: [...TASKMARKET_CONTEXTS],
  // Guard 1: a non-owner in a shared agent never reaches the spend path.
  roleGate: { minRole: "OWNER" },
  similes: [
    "DELEGATE_TO_TASKMARKET",
    "POST_TASKMARKET_TASK",
    "HIRE_AGENT_WORKER",
  ],
  description:
    "Post a paid task to the TaskMarket worker marketplace when work is better delegated to external workers than solved with more inference. SPENDS REAL MONEY: creating a task escrows the reward in USDC on Base immediately. Owner-only, disabled unless the operator sets TASKMARKET_ALLOW_TASK_CREATION, capped by TASKMARKET_MAX_TASK_REWARD_USDC, and confirmed by the user on a follow-up turn before anything is posted.",
  parameters: [
    {
      name: "description",
      description:
        "The full task brief workers will see: deliverable, acceptance criteria, and format.",
      required: true,
      schema: {
        type: "string",
        minLength: MIN_DESCRIPTION_CHARS,
        maxLength: MAX_DESCRIPTION_CHARS,
      },
    },
    {
      name: "rewardUsdc",
      description:
        "Reward in whole USDC (e.g. 0.5 for fifty cents). Escrowed on creation. Must be at least 0.000001 (one atomic unit). A value above the configured ceiling is refused, not reduced.",
      required: true,
      schema: { type: "number" },
    },
    {
      name: "durationHours",
      description: `How long the task stays open, in hours. Default ${DEFAULT_DURATION_HOURS}, max ${MAX_DURATION_HOURS}.`,
      required: false,
      schema: { type: "number" },
    },
    {
      name: "tags",
      description: "Comma-separated tags, max 10.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "mode",
      description:
        "Task mode: bounty (default), claim, pitch, benchmark or auction.",
      required: false,
      schema: {
        type: "string",
        enum: ["bounty", "claim", "pitch", "benchmark", "auction"],
      },
    },
  ],
  // Guard 2 is enforced here as well as in the handler, so a disabled capability
  // is never even offered to the planner.
  validate: async (runtime: IAgentRuntime) => {
    const config = resolveTaskMarketConfig(runtime);
    return config?.allowTaskCreation === true;
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    options?: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const config = resolveTaskMarketConfig(runtime);
    if (!config) {
      return failureActionResult({
        reason: "not_configured",
        message:
          "TASKMARKET_API_TOKEN and TASKMARKET_ADDRESS must both be set (the API bearer token does not identify the caller).",
      });
    }

    // Guard 2 (re-checked at handler entry: a disabled capability must never
    // spend through any invocation path, including a hallucinated tool call).
    if (!config.allowTaskCreation) {
      return failureActionResult({
        reason: "creation_disabled",
        message:
          "Task creation is disabled. Set TASKMARKET_ALLOW_TASK_CREATION=true to allow this agent to escrow USDC.",
      });
    }

    const description = readStringParam(options, "description");
    if (!description || description.length < MIN_DESCRIPTION_CHARS) {
      return failureActionResult({
        reason: "missing_param",
        message: `description is required and must be at least ${MIN_DESCRIPTION_CHARS} characters`,
      });
    }
    if (description.length > MAX_DESCRIPTION_CHARS) {
      return failureActionResult({
        reason: "invalid_param",
        message: `description exceeds the ${MAX_DESCRIPTION_CHARS} character API limit`,
      });
    }

    const rewardUsdc = readNumberParam(options, "rewardUsdc");
    if (rewardUsdc === undefined || rewardUsdc <= 0) {
      return failureActionResult({
        reason: "missing_param",
        message: "rewardUsdc is required and must be greater than 0",
      });
    }

    // Precision check before anything is previewed or posted. A reward below
    // one atomic unit serializes to "0": the API would escrow nothing while the
    // handler reported the requested amount as escrowed.
    const rewardAtomic = usdcToAtomic(rewardUsdc);
    if (rewardAtomic === undefined) {
      return failureActionResult(
        {
          reason: "invalid_param",
          message: `Reward ${rewardUsdc} USDC cannot be represented in the 6-decimal atomic units the API uses; it would post 0. The minimum is 0.000001 USDC.`,
        },
        {
          action: "TASKMARKET_CREATE_TASK",
          requestedUsdc: rewardUsdc,
        },
      );
    }
    // Report the amount actually posted, not the amount asked for.
    const normalizedUsdc = Number(rewardAtomic) / 1_000_000;

    // Guard 3: refuse over-budget rather than trimming to the cap.
    if (normalizedUsdc > config.maxTaskRewardUsdc) {
      return failureActionResult(
        {
          reason: "over_budget",
          message: `Requested reward ${normalizedUsdc} USDC exceeds the configured ceiling of ${config.maxTaskRewardUsdc} USDC. Refusing rather than reducing the reward; raise TASKMARKET_MAX_TASK_REWARD_USDC deliberately if this spend is intended.`,
        },
        {
          action: "TASKMARKET_CREATE_TASK",
          requestedUsdc: normalizedUsdc,
          maxTaskRewardUsdc: config.maxTaskRewardUsdc,
        },
      );
    }

    const requestedDuration = readNumberParam(options, "durationHours");
    const duration =
      requestedDuration && requestedDuration > 0
        ? Math.min(MAX_DURATION_HOURS, Math.floor(requestedDuration))
        : DEFAULT_DURATION_HOURS;

    // Guard 4: two-turn confirmation against the real user message. The pending
    // key is the fingerprint of this exact brief and reward, so a changed task
    // or amount can never be settled by a previous approval — it starts a new
    // preview instead.
    const fingerprint = spendFingerprint(description, rewardAtomic);
    const prompt = `Post this task to TaskMarket and escrow ${normalizedUsdc} USDC on Base for ${duration}h? This spends real funds and cannot be undone from this agent.\n\n"${description.slice(0, 300)}${description.length > 300 ? "…" : ""}"\n\nReply yes to confirm or no to cancel.`;
    const gate = await gateDestructiveConfirmation({
      runtime,
      message,
      actionName: "TASKMARKET_CREATE_TASK",
      pendingKey: `create:${fingerprint}`,
      prompt,
      callback,
      ttlMs: CONFIRMATION_TTL_MS,
      metadata: { fingerprint, rewardAtomic, duration },
    });

    if (gate.status === "pending") {
      return successActionResult(prompt, {
        action: "TASKMARKET_CREATE_TASK",
        requiresConfirmation: true,
        awaitingUserInput: true,
        rewardUsdc: normalizedUsdc,
        durationHours: duration,
      });
    }
    if (gate.status === "cancelled") {
      return failureActionResult(
        {
          reason: "cancelled",
          message: "Task creation cancelled; no USDC was escrowed.",
        },
        { action: "TASKMARKET_CREATE_TASK" },
      );
    }

    // Backstop against a confirmation record that does not describe this spend.
    if (
      gate.metadata?.fingerprint !== fingerprint ||
      gate.metadata?.rewardAtomic !== rewardAtomic
    ) {
      return failureActionResult(
        {
          reason: "confirmation_drift",
          message:
            "The confirmed task no longer matches the task being posted. Refusing to escrow; re-run the request to review and approve the current task and reward.",
        },
        { action: "TASKMARKET_CREATE_TASK" },
      );
    }

    try {
      const result = await createTask(config, {
        description,
        reward: rewardAtomic,
        duration,
        tags: parseTags(readStringParam(options, "tags")),
        ...(readStringParam(options, "mode")
          ? { mode: readStringParam(options, "mode") as string }
          : {}),
      });
      return successActionResult(
        `Created TaskMarket task ${result.taskId} with ${normalizedUsdc} USDC escrowed for ${duration}h. Selecting a winner and releasing escrow are manual steps on taskmarket.dev.`,
        {
          action: "TASKMARKET_CREATE_TASK",
          taskId: result.taskId,
          rewardUsdc: normalizedUsdc,
          rewardAtomic,
          durationHours: duration,
        },
      );
    } catch (error) {
      if (error instanceof TaskMarketApiError) {
        return failureActionResult(
          {
            reason: "api_error",
            message: `HTTP ${error.status}: ${error.message}`,
          },
          { action: "TASKMARKET_CREATE_TASK" },
        );
      }
      const message = error instanceof Error ? error.message : String(error);
      return failureActionResult(
        {
          reason:
            error instanceof TaskMarketResponseError
              ? "invalid_response"
              : "io_error",
          message,
        },
        { action: "TASKMARKET_CREATE_TASK" },
      );
    }
  },
};
