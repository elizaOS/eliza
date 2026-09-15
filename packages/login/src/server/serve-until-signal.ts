/** Reports service readiness and closes owned connections on process termination. */
import { logger } from "@elizaos/logger";

export async function serveUntilSignal(server: {
  port: number | undefined;
  stop(): Promise<void>;
}): Promise<void> {
  logger.info({ port: server.port }, "[Login] Identity API listening");
  await new Promise<void>((resolve, reject) => {
    const shutdown = () => {
      process.off("SIGINT", shutdown);
      process.off("SIGTERM", shutdown);
      server.stop().then(resolve, reject);
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}
