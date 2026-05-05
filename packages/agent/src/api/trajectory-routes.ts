import type http from "node:http";
import type { AgentRuntime } from "@elizaos/core";
import { sendJsonError } from "./http-helpers.js";

const TRAJECTORY_ROUTES_MODULE: string =
  "@elizaos/app-training/routes/trajectory";

type TrajectoryRoutesModule = {
  handleTrajectoryRoute?: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    runtime: AgentRuntime,
    pathname: string,
    method: string,
  ) => Promise<boolean> | boolean;
};

export async function handleTrajectoryRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  runtime: AgentRuntime,
  pathname: string,
  method: string,
): Promise<boolean> {
  if (!pathname.startsWith("/api/trajectories")) return false;

  try {
    const loaded = (await import(
      /* @vite-ignore */ TRAJECTORY_ROUTES_MODULE
    )) as TrajectoryRoutesModule;
    if (typeof loaded.handleTrajectoryRoute !== "function") {
      sendJsonError(res, "Training trajectory routes are not available", 503);
      return true;
    }
    return await loaded.handleTrajectoryRoute(
      req,
      res,
      runtime,
      pathname,
      method,
    );
  } catch {
    sendJsonError(res, "Training trajectory routes are not available", 503);
    return true;
  }
}

export type { TrajectoryExportFormat } from "../types/trajectory.js";
