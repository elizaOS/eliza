/** Rejects occupied development ports without signaling their current owners. */
import { createServer } from "node:net";

export async function assertDevPortsAvailable(ports) {
  if (new Set(ports).size !== ports.length) {
    throw new Error("Eliza UI and API require different ports.");
  }
  for (const port of ports) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`Invalid Eliza development port: ${port}`);
    }
    for (const host of ["127.0.0.1", "::1"]) {
      const server = createServer();
      await new Promise((resolve, reject) => {
        server.once("error", (cause) => {
          if (
            host === "::1" &&
            ["EAFNOSUPPORT", "EADDRNOTAVAIL"].includes(cause.code)
          ) {
            resolve();
            return;
          }
          reject(
            new Error(
              `Cannot bind Eliza development port ${port}. Choose unused ELIZA_UI_PORT and ELIZA_API_PORT values or stop its owner explicitly. No existing process was stopped.`,
              { cause },
            ),
          );
        });
        server.listen({ port, host, exclusive: true }, () => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      });
    }
  }
}
