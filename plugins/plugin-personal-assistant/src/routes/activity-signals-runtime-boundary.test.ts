/**
 * Verifies route-only app composition cannot persist activity or report fatal
 * runtime errors when Personal Assistant did not register its signal sources.
 */

import type http from "node:http";
import type { AgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import type { LifeOpsRouteContext } from "./lifeops-routes.js";
import { handleLifeOpsRoutes } from "./lifeops-routes.js";

describe("activity-signal runtime boundary", () => {
  it("returns 503 before parsing or persistence when the runtime registry is absent", async () => {
    const reportError = vi.fn();
    const adapterQuery = vi.fn();
    const runtime = {
      adapter: { query: adapterQuery },
      reportError,
    } as unknown as AgentRuntime;
    const error = vi.fn();
    const readJsonBody = vi.fn();
    const context = {
      req: {} as http.IncomingMessage,
      res: {} as http.ServerResponse,
      method: "POST",
      pathname: "/api/lifeops/activity-signals",
      url: new URL("http://127.0.0.1/api/lifeops/activity-signals"),
      state: { runtime, adminEntityId: null },
      json: vi.fn(),
      error,
      readJsonBody,
      decodePathComponent: vi.fn(),
    } satisfies LifeOpsRouteContext;

    const handled = await handleLifeOpsRoutes(context);

    expect(handled).toBe(true);
    expect(error).toHaveBeenCalledWith(
      context.res,
      "Personal Assistant activity signals are unavailable because the runtime plugin is not active",
      503,
    );
    expect(readJsonBody).not.toHaveBeenCalled();
    expect(adapterQuery).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
  });
});
