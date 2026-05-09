import type http from "node:http";
import type { AgentRuntime } from "@elizaos/core";
import type { CloudProxyConfigLike } from "@elizaos/agent/types/config-like";
import { sendJsonError } from "@elizaos/agent/api/http-helpers";

const LIFEOPS_CLOUD_FEATURES_MODULE: string =
  "@elizaos/app-lifeops/routes/cloud-features-routes";

export interface CloudFeaturesRouteState {
  config: CloudProxyConfigLike;
  runtime?: AgentRuntime | null;
}

type CloudFeaturesRoutesModule = {
  handleCloudFeaturesRoute?: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    pathname: string,
    method: string,
    state: CloudFeaturesRouteState,
  ) => Promise<boolean> | boolean;
};

export async function handleCloudFeaturesRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  method: string,
  state: CloudFeaturesRouteState,
): Promise<boolean> {
  if (
    pathname !== "/api/cloud/features" &&
    pathname !== "/api/cloud/features/sync"
  ) {
    return false;
  }

  try {
    const loaded = (await import(
      /* @vite-ignore */ LIFEOPS_CLOUD_FEATURES_MODULE
    )) as CloudFeaturesRoutesModule;
    if (typeof loaded.handleCloudFeaturesRoute !== "function") {
      sendJsonError(res, "LifeOps cloud feature routes are not available", 503);
      return true;
    }
    return await loaded.handleCloudFeaturesRoute(
      req,
      res,
      pathname,
      method,
      state,
    );
  } catch {
    sendJsonError(res, "LifeOps cloud feature routes are not available", 503);
    return true;
  }
}
