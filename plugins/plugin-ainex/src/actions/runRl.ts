// `AINEX_RUN_RL` — the single text-conditioned action. Replaces the
// 15 programmatic actions when the plugin runs in "rl" mode: instead
// of mapping each chat phrase to a specific bridge command, this
// action ships the raw text to `policy.start` and lets the trained
// text-conditioned policy decide which joint targets to emit.

import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { getStringOption, sendOne } from "./_helpers";

export const runRlAction: Action = {
  name: "AINEX_RUN_RL",
  similes: [
    "RUN_RL",
    "TEXT_COMMAND",
    "ROBOT_DO",
    "ROBOT_SAY",
    "PERFORM_TASK",
    "EXECUTE_TASK",
  ],
  description:
    "Run a text-conditioned learned policy on the AiNex. Pass `options.text` " +
    "(or options.task) with the free-form instruction; the bridge ships it " +
    "as `policy.start { task: <text> }` and the trained policy emits joint " +
    "targets. Optional: options.hz (1-30, default 10), options.max_steps.",
  examples: [],
  validate: async (_runtime: IAgentRuntime, _message: Memory) => true,
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined,
    options: Record<string, unknown> | undefined,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const text =
      getStringOption(options, "text", "") ||
      getStringOption(options, "task", "") ||
      (typeof message?.content === "object" &&
        message?.content !== null &&
        typeof (message.content as { text?: unknown }).text === "string"
        ? ((message.content as { text: string }).text)
        : "");
    if (text === "") {
      const t = "AINEX_RUN_RL requires options.text or options.task.";
      await callback?.({ text: t });
      return { success: false, text: t };
    }
    const hz =
      typeof options?.hz === "number" && options.hz > 0 ? options.hz : 10;
    const maxSteps =
      typeof options?.max_steps === "number" && options.max_steps > 0
        ? options.max_steps
        : 1500;
    return sendOne(
      runtime,
      callback,
      "policy.start",
      {
        task: text,
        canonical_action: "text_conditioned",
        target_label: getStringOption(options, "target_label", ""),
        hz,
        max_steps: maxSteps,
      },
      `AiNex is performing "${text}" via the trained policy.`,
      `run_rl(${text})`,
    );
  },
};
