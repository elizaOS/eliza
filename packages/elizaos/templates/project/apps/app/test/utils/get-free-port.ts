import { createServer } from "node:net";

/**
 * Pick an unused TCP port on the loopback interface.
 * Race-safe for test scenarios: the OS returns a free port, the listener
 * closes, and the caller binds to that port shortly after.
 */
export async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("getFreePort: unexpected address shape"));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}
