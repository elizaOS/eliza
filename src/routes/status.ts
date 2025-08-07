import type { Request, Response } from "express";
import { isHex } from "viem";
import {
  createUniqueUuid,
  IAgentRuntime,
  logger,
  Route,
  UUID,
} from "@elizaos/core";
import { LEVVA_SERVICE } from "../constants/enum";
import { LevvaService } from "../services/levva/class";

async function handler(req: Request, res: Response, runtime: IAgentRuntime) {
  const { address } = req.query;

  try {
    const service = runtime.getService<LevvaService>(
      LEVVA_SERVICE.LEVVA_COMMON
    );

    if (!service) {
      throw new Error("Service not found");
    }

    if (!isHex(address)) {
      throw new Error("Invalid address");
    }

    const user = await service.getUser(address);

    if (!user) {
      throw new Error("User not found");
    }

    const entityId = createUniqueUuid(runtime, user.id);

    const [lastMessage] = await runtime.getMemories({
      entityId,
      tableName: "messages",
    });

    let ready = true;
    const messageId = lastMessage?.id;

    if (!messageId) {
      res.json({
        success: true,
        data: {
          ready,
        },
      });

      return;
    }

    const state = await runtime.composeState(
      lastMessage,
      ["ACTION_STATE"],
      true
    );

    const actionState = state.data.providers?.["ACTION_STATE"]?.data as
      | undefined
      | {
          actionResults: {}[];
          actionPlan?: { totalSteps: number };
        };

    if (!actionState?.actionPlan) {
      res.json({
        success: true,
        data: {
          ready,
          actionState
        },
      });

      return;
    }

    for (let i = 0; i < actionState.actionPlan.totalSteps; i++) {
      const result = actionState.actionResults[i];
      // todo check result

      if (!result) {
        ready = false;
        break;
      }
    }

    res.json({
      success: true,
      data: {
        ready,
        actionPlan: actionState.actionPlan,
        actionResults: actionState.actionResults,
      },
    });
  } catch (error) {
    logger.error(error);

    res.status(500).json({
      success: false,
      error: {
        code: "SERVER_ERROR",
        message: error instanceof Error ? error.message : "Unknown error",
      },
    });
  }
}

const statusRoute: Route = {
  name: "status",
  path: "/status",
  type: "GET",
  handler,
};

export default statusRoute;
