import { createServer } from "node:net";

export function getFreePort() {
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
