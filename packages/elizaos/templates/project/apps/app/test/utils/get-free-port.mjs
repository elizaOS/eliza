import { createServer } from "node:net";

export async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        reject(new Error("getFreePort: bad addr"));
        return;
      }
      server.close(() => resolve(addr.port));
    });
  });
}
