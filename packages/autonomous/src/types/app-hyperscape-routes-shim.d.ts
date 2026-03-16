declare module "@elizaos/app-hyperscape/routes" {
  import type * as http from "node:http";

  export interface HyperscapeRelayOptions {
    rawBodyOverride?: string;
    contentTypeOverride?: string;
  }

  export interface AppsHyperscapeRouteContext {
    req: http.IncomingMessage;
    res: http.ServerResponse;
    method: string;
    pathname: string;
    readJsonBody: <T extends object>(
      req: http.IncomingMessage,
      res: http.ServerResponse,
    ) => Promise<T | null>;
    error: (res: http.ServerResponse, message: string, status?: number) => void;
    relayHyperscapeApi: (
      method: "GET" | "POST",
      path: string,
      options?: HyperscapeRelayOptions,
    ) => Promise<void>;
  }

  export function handleAppsHyperscapeRoutes(
    ctx: AppsHyperscapeRouteContext,
  ): Promise<boolean>;
}
