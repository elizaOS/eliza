import { getHttpRuntime, type IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { buildHonoAppForRuntime } from "./hono-adapter.ts";

describe("hono-adapter", () => {
  it.each([204, 205, 304])(
    "drops a handler body for null-body status %i",
    async (status) => {
      const runtime = {} as IAgentRuntime;
      getHttpRuntime(runtime).routes.push({
        type: "GET",
        path: "/api/null-body-status",
        routeHandler: async () => ({ status, body: { ignored: true } }),
      });
      const app = buildHonoAppForRuntime(runtime, { isAuthorized: () => true });

      const response = await app.request("/api/null-body-status");

      expect(response.status).toBe(status);
      expect(await response.text()).toBe("");
    },
  );
});
