/** Real HTTP coverage for the Website Blocker web bridge request deadline. */
import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WebsiteBlockerWeb } from "../src/web";

describe("WebsiteBlockerWeb request deadline", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("aborts a status request when the runtime stalls before its response", async () => {
    const server = createServer(() => {
      // Accept the request but do not send response headers.
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("Loopback server did not expose a TCP address");
    }

    vi.stubGlobal("window", {
      location: {
        protocol: "http:",
        origin: `http://127.0.0.1:${address.port}`,
      },
      sessionStorage: {
        getItem: vi.fn(() => null),
      },
      __ELIZAOS_APP_BOOT_CONFIG__: {
        apiBase: `http://127.0.0.1:${address.port}`,
      },
    } as unknown as Window);

    const timeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => timeout(50));

    try {
      const outcome = new WebsiteBlockerWeb().getStatus().then(
        () => "resolved",
        (error: unknown) =>
          error instanceof Error ? error.name : String(error),
      );
      const observed = await Promise.race([
        outcome,
        new Promise<string>((resolve) => {
          setTimeout(() => resolve("still pending"), 250);
        }),
      ]);

      expect(observed).toBe("TimeoutError");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
