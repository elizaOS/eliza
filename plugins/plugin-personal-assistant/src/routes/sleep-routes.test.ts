/** Verifies the LifeOps-to-health sleep route adapter preserves routing and runtime-unavailable responses. */

import type http from "node:http";
import type { UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import type { LifeOpsRouteContext } from "./lifeops-routes.js";
import { handleSleepRoutes } from "./sleep-routes.js";

function createContext(path: string): {
  ctx: LifeOpsRouteContext;
  error: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
} {
  const url = new URL(`https://example.test${path}`);
  const error = vi.fn();
  const json = vi.fn();
  const res = {} as http.ServerResponse;
  return {
    ctx: {
      req: {} as http.IncomingMessage,
      res,
      method: "GET",
      pathname: url.pathname,
      url,
      state: {
        runtime: null,
        adminEntityId: null as UUID | null,
      },
      json,
      error,
      readJsonBody: vi.fn(),
      decodePathComponent: vi.fn(),
    },
    error,
    json,
  };
}

describe("handleSleepRoutes", () => {
  it("returns a 503 through the LifeOps response boundary when runtime is unavailable", async () => {
    const { ctx, error, json } = createContext(
      "/api/lifeops/sleep/history?windowDays=14&includeNaps=true",
    );

    await expect(handleSleepRoutes(ctx)).resolves.toBe(true);

    expect(error).toHaveBeenCalledWith(
      ctx.res,
      "Agent runtime is not available",
      503,
    );
    expect(json).not.toHaveBeenCalled();
  });

  it("leaves unrelated LifeOps routes for the next route handler", async () => {
    const { ctx, error, json } = createContext("/api/lifeops/todos");

    await expect(handleSleepRoutes(ctx)).resolves.toBe(false);

    expect(error).not.toHaveBeenCalled();
    expect(json).not.toHaveBeenCalled();
  });
});
