import { describe, expect, test } from "bun:test";

import { respondMcpResponse } from "./route";

describe("agent MCP response policy", () => {
  test("suppresses a failure response for a notification", async () => {
    const failure = Response.json(
      {
        jsonrpc: "2.0",
        error: { code: -32002, message: "Unauthorized" },
        id: null,
      },
      { status: 401 },
    );

    const response = respondMcpResponse(failure, true);

    expect(response.status).toBe(202);
    expect(await response.text()).toBe("");
  });

  test("preserves a failure response for a request with an id", async () => {
    const failure = Response.json(
      {
        jsonrpc: "2.0",
        error: { code: -32002, message: "Unauthorized" },
        id: 7,
      },
      { status: 401 },
    );

    const response = respondMcpResponse(failure, false);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      jsonrpc: "2.0",
      error: { code: -32002, message: "Unauthorized" },
      id: 7,
    });
  });
});
