import type { Plugin } from "@elizaos/core";

import {
  type RouteRequest,
  type RouteResponse,
  logger,
} from "@elizaos/core";

import { z } from "zod";
import { KaminoService } from "./services/kamino";
import { LendAction } from "./actions/lending/lendAction";
import { LendWithdraw } from "./actions/lending/lendWithdraw";
import { depositAction } from "./actions/lending/deposit";
import { WithdrawAction } from "./actions/lending/withdraw";
import { BorrowAction } from "./actions/lending/borrow";
import { RepayAction } from "./actions/lending/repay";
import { ReserveAction } from "./actions/lending/reservesAction";
import { HealthAction } from "./actions/lending/health";
import { marketProvider } from "./providers/marketProvider";

const configSchema = z.object({
  SOLANA_RPC_URL: z.string().min(1, "Solana RPC URL is required"),
  SOLANA_PRIVATE_KEY: z.string().min(1, "Solana private key is required"),
});

export const KaminoPlugin: Plugin = {
  name: "plugin-kamino",
  description:
    "plugin-kamino is the elizaos plugin of kamino. Lending, borrowing, earn etc. all features of kamino are available.",

  config: {
    SOLANA_RPC_URL: process.env.SOLANA_RPC_URL,
    SOLANA_PRIVATE_KEY: process.env.SOLANA_PRIVATE_KEY,
  },
  async init(config: Record<string, string>) {
    logger.info("Initializing plugin-kamino");
    try {
      const validatedConfig = await configSchema.parseAsync(config);

      // Set all environment variables at once
      for (const [key, value] of Object.entries(validatedConfig)) {
        if (value) process.env[key] = value;
      }
    } catch (error) {
      if (error instanceof z.ZodError) {
        const errorMessages =
          error.issues?.map((e) => e.message)?.join(", ") ||
          "Unknown validation error";
        throw new Error(`Invalid plugin configuration: ${errorMessages}`);
      }
      throw new Error(
        `Invalid plugin configuration: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  },

  routes: [
    {
      name: "api-status",
      path: "/api/status",
      type: "GET",
      handler: async (_req: RouteRequest, res: RouteResponse) => {
        res.json({
          status: "ok",
          plugin: "plugin-kamino",
          timestamp: new Date().toISOString(),
        });
      },
    },
  ],
  // events: {
  //   [EventType.MESSAGE_RECEIVED]: [
  //     async (params: MessagePayload) => {
  //       logger.debug("MESSAGE_RECEIVED event received");
  //       logger.debug({ message: params.message }, "Message:");
  //     },
  //   ],
  //   [EventType.VOICE_MESSAGE_RECEIVED]: [
  //     async (params: MessagePayload) => {
  //       logger.debug("VOICE_MESSAGE_RECEIVED event received");
  //       logger.debug({ message: params.message }, "Message:");
  //     },
  //   ],
  //   [EventType.WORLD_CONNECTED]: [
  //     async (params: WorldPayload) => {
  //       logger.debug("WORLD_CONNECTED event received");
  //       logger.debug({ world: params.world }, "World:");
  //     },
  //   ],
  //   [EventType.WORLD_JOINED]: [
  //     async (params: WorldPayload) => {
  //       logger.debug("WORLD_JOINED event received");
  //       logger.debug({ world: params.world }, "World:");
  //     },
  //   ],
  // },
  services: [KaminoService],
  actions: [
    LendAction,
    depositAction,
    BorrowAction,
    LendWithdraw,
    WithdrawAction,
    RepayAction,
    ReserveAction,
    HealthAction,
  ],
  providers: [marketProvider],
};

export default KaminoPlugin;
