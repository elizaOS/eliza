import { type Request, type Response } from "express";
import { IAgentRuntime, Route } from "@elizaos/core";
import { ILevvaService } from "src/types/service";
import { LEVVA_SERVICE } from "src/constants/enum";

async function handler(req: Request, res: Response, runtime: IAgentRuntime) {
  const { hash } = req.query;

  if (!hash) {
    res.status(400).json({
      success: false,
      error: {
        code: "WRONG_REQUEST",
        message: "Hash is required",
      },
    });
    return;
  }

  try {
    const service = runtime.getService<ILevvaService>(
      LEVVA_SERVICE.LEVVA_COMMON
    );

    if (!service) {
      throw new Error("Service not found");
    }

    const calldata = await service.getCalldata(hash as `0x${string}`);

    res.status(200).json({
      success: true,
      data: calldata,
    });
  } catch (e) {
    res.status(500).json({
      success: false,
      error: {
        code: "ERROR_500",
        message: (e as Error).message ?? "Unknown error",
      },
    });
  }
}

const calldataRoute: Route = {
  name: "calldata",
  path: "/calldata",
  type: "GET",
  handler,
};

export default calldataRoute;
