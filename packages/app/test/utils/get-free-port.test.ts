import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { getFreePort } from "./get-free-port";

describe("getFreePort", () => {
  it("returns a bindable port", async () => {
    const port = await getFreePort();
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThan(65536);

    await new Promise<void>((resolve, reject) => {
      const srv = createServer();
      srv.on("error", reject);
      srv.listen(port, "127.0.0.1", () => srv.close(() => resolve()));
    });
  });

  it("returns different ports across calls", async () => {
    const [a, b, c] = await Promise.all([
      getFreePort(),
      getFreePort(),
      getFreePort(),
    ]);
    expect(new Set([a, b, c]).size).toBeGreaterThanOrEqual(2);
  });
});
