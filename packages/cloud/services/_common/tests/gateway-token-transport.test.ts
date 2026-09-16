/** Exercises shared gateway token acquisition against real HTTP response bodies and deadlines. */
import { describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import { requestGatewayToken } from "../src/gateway-auth";

describe("gateway token transport", () => {
  test.each([200, 503])(
    "aborts a stalled %i body after headers arrive",
    async (status) => {
      let sentHeaders = false;
      const server = createServer((_request, response) => {
        response.writeHead(status, { "Content-Type": "application/json" });
        response.flushHeaders();
        response.write("{");
        sentHeaders = true;
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Expected TCP listener");
      try {
        await expect(
          requestGatewayToken(
            `http://127.0.0.1:${address.port}`,
            { method: "POST" },
            100,
          ),
        ).rejects.toMatchObject({ name: "TimeoutError" });
        expect(sentHeaders).toBe(true);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );

  test("preserves the complete provider diagnostic on HTTP failure", async () => {
    const detail = "provider rejected enrollment: " + "reason ".repeat(1000);
    const server = createServer((_request, response) => {
      response.writeHead(503);
      response.end(detail);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Expected TCP listener");
    try {
      await expect(
        requestGatewayToken(`http://127.0.0.1:${address.port}`, {}),
      ).rejects.toThrow(detail);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("reads a complete token response and rejects malformed token data", async () => {
    let valid = true;
    const token = {
      access_token: "signed-token",
      token_type: "Bearer",
      expires_in: 60,
    };
    const server = createServer((_request, response) =>
      response.end(JSON.stringify(valid ? token : { access_token: "invalid" })),
    );
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Expected TCP listener");
    try {
      const url = `http://127.0.0.1:${address.port}`;
      expect(await requestGatewayToken(url, {})).toEqual(token);
      valid = false;
      await expect(requestGatewayToken(url, {})).rejects.toThrow(
        "Invalid gateway token response",
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
