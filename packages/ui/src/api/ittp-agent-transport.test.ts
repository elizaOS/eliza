import { describe, expect, it } from "vitest";
import { createIttpAgentTransport } from "./ittp-agent-transport";

describe("createIttpAgentTransport", () => {
  it("dispatches to a request handler with timeout context", async () => {
    const transport = createIttpAgentTransport(async (request, context) => {
      return Response.json({
        pathname: new URL(request.url).pathname,
        timeoutMs: context.timeoutMs,
      });
    });

    const response = await transport.request(
      "http://127.0.0.1:31337/api/status",
      {},
      { timeoutMs: 1234 },
    );

    await expect(response.json()).resolves.toEqual({
      pathname: "/api/status",
      timeoutMs: 1234,
    });
  });

  it("dispatches directly to a fetch-shaped route kernel", async () => {
    const transport = createIttpAgentTransport({
      fetch(request) {
        return Response.json({
          method: request.method,
          pathname: new URL(request.url).pathname,
        });
      },
    });

    const response = await transport.request(
      "http://127.0.0.1:31337/api/health",
      { method: "POST" },
    );

    await expect(response.json()).resolves.toEqual({
      method: "POST",
      pathname: "/api/health",
    });
  });
});
