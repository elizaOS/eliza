/**
 * Guards the app-core API wrapper's bind-first contract. The API server must
 * bind its HTTP listener and return an active port without blocking on
 * platform credential stores.
 */
import { describe, expect, it } from "vitest";
import { startApiServer } from "./server.ts";

describe("app-core API bind-first contract", () => {
  it("binds the HTTP listener and returns an active server instance", async () => {
    const server = await startApiServer({
      port: 0,
      skipDeferredStartupWork: true,
    });

    try {
      expect(server).toBeDefined();
      expect(typeof server.port).toBe("number");
      expect(server.port).toBeGreaterThan(0);
    } finally {
      await server.close();
    }
  });
});
