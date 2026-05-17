import type http from "node:http";
export declare function sendJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
): void;
export declare function sendJsonError(
  res: http.ServerResponse,
  status: number,
  message: string,
): void;
//# sourceMappingURL=response.d.ts.map
