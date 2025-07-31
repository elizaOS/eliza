import { type Request, type Response } from "express";
import { isHex } from "viem";
import {
  createUniqueUuid,
  findWorldsForOwner,
  IAgentRuntime,
  Route,
  UUID,
} from "@elizaos/core";
import { LEVVA_SERVICE } from "../constants/enum";
import { LevvaService } from "../services/levva/class";
import { createLevvaUser, getLevvaUser, getLogger } from "../util";

const DEFAULT_SERVER_ID: UUID = "00000000-0000-0000-0000-000000000000";

async function handler(req: Request, res: Response, runtime: IAgentRuntime) {
  const { address } = req.query;
  const logger = getLogger(runtime);

  try {
    const authHeader = req.header("Authorization");

    if (!authHeader) {
      throw new Error("No authorization header");
    }

    const service = runtime.getService<LevvaService>(
      LEVVA_SERVICE.LEVVA_COMMON
    );

    if (!service) {
      throw new Error("Service not found");
    }

    const secret = await service.checkSecret(authHeader.split(" ")[1]);

    if (!isHex(address)) {
      throw new Error("Invalid address");
    }

    const result = await getLevvaUser(runtime, { address });

    let id: string;

    if (!result.length) {
      logger.info(`User ${address} not found, creating...`);

      const result = await createLevvaUser(runtime, {
        address,
        creatorId: secret.id as UUID,
      });
      id = result.id;
    } else {
      logger.info(`User ${address} found, id: ${result[0].id}`);
      id = result[0].id;
    }

    const entityId = createUniqueUuid(runtime, id);
    const entity = await runtime.getEntityById(entityId);

    if (!entity) {
      if (
        !(await runtime.createEntity({
          id: entityId,
          names: [`User-${id}`, `User-${address}`],
          agentId: runtime.agentId,
          metadata: {
            eth: { address },
          },
        }))
      ) {
        throw new Error("Failed to create entity");
      }
    }

    const worlds = await findWorldsForOwner(runtime, entityId);
    let worldId = worlds?.[0]?.id;

    if (!worldId) {
      // @ts-expect-error createWorld expects id
      worldId = await runtime.createWorld({
        name: `Levva:${address}`,
        agentId: runtime.agentId,
        serverId: DEFAULT_SERVER_ID,
        metadata: {
          ownership: {
            ownerId: entityId,
          },
          settings: {},
        },
      });
    }

    res.status(200).json({ success: true, data: { id, worldId } });
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

const route: Route = {
  name: "levva-user",
  path: "/levva-user",
  type: "GET",
  handler,
};

export default route;
