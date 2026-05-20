import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { getNumberOption, getService, notConnected, sendOne } from "./_helpers";
import type { JsonDict } from "../types";

interface ServoTarget {
  id: number;
  position: number;
}

function _parsePositions(options: Record<string, unknown> | undefined): ServoTarget[] | null {
  const positions = options?.positions;
  if (Array.isArray(positions)) {
    const out: ServoTarget[] = [];
    for (const item of positions) {
      if (
        item &&
        typeof item === "object" &&
        typeof (item as ServoTarget).id === "number" &&
        typeof (item as ServoTarget).position === "number"
      ) {
        out.push({
          id: (item as ServoTarget).id,
          position: (item as ServoTarget).position,
        });
      }
    }
    return out.length === 0 ? null : out;
  }
  // Single-servo convenience form: options.id + options.position
  const id = options?.id;
  const position = options?.position;
  if (typeof id === "number" && typeof position === "number") {
    return [{ id, position }];
  }
  return null;
}

export const setServoAction: Action = {
  name: "AINEX_SET_SERVO",
  similes: ["SET_SERVO", "MOVE_SERVO", "MOVE_JOINT", "SET_JOINT"],
  description:
    "Drive one or more AiNex servos to target pulse positions over a duration. Options: positions=[{id, position}], duration (seconds, default 0.5).",
  examples: [],
  validate: async (_runtime: IAgentRuntime, _message: Memory) => true,
  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State | undefined,
    options: Record<string, unknown> | undefined,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const positions = _parsePositions(options);
    if (positions === null) {
      const text =
        "AINEX_SET_SERVO requires options.positions=[{id,position}] or options.id+options.position.";
      await callback?.({ text });
      return { success: false, text };
    }
    if (!getService(runtime)) {
      return notConnected(callback, "set servo");
    }
    const duration = getNumberOption(options, "duration", 0.5);
    const payload: JsonDict = {
      duration,
      positions: positions.map((p) => ({ id: p.id, position: p.position })),
    };
    return sendOne(
      runtime,
      callback,
      "servo.set",
      payload,
      `AiNex servos updated (${positions.length} joints).`,
      "set servo",
    );
  },
};
