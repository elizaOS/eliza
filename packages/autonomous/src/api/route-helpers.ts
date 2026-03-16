import type http from "node:http";
import type { ReadJsonBodyOptions } from "./http-helpers";

export interface RouteRequestMeta {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  method: string;
  pathname: string;
}

export interface RouteHelpers {
  json: (res: http.ServerResponse, data: object, status?: number) => void;
  error: (res: http.ServerResponse, message: string, status?: number) => void;
  readJsonBody: <T extends object>(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    options?: ReadJsonBodyOptions,
  ) => Promise<T | null>;
}

export interface RouteRequestContext extends RouteRequestMeta, RouteHelpers {}
