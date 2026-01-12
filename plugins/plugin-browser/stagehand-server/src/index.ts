import { config } from "dotenv";
import { WebSocketServer } from "ws";
import { Logger } from "./logger.js";
import { MessageHandler } from "./message-handler.js";
import { PlaywrightInstaller } from "./playwright-installer.js";
import { SessionManager } from "./session-manager.js";

config();

const PORT = process.env.STAGEHAND_SERVER_PORT || 3456;
const logger = new Logger();
const playwrightInstaller = new PlaywrightInstaller(logger);

async function startServer() {
  logger.info(`Stagehand server starting on port ${PORT}`);

  try {
    await playwrightInstaller.ensurePlaywrightInstalled();
  } catch (error) {
    logger.error("Failed to ensure Playwright installation:", error);
    logger.warn(
      "Server will start but Stagehand operations may fail until Playwright is installed",
    );
  }

  const wss = new WebSocketServer({ port: Number(PORT) });
  const sessionManager = new SessionManager(logger, playwrightInstaller);
  const messageHandler = new MessageHandler(sessionManager, logger);

  logger.info(`Stagehand server initialization complete`);

  wss.on("connection", (ws) => {
    const clientId = `client-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    logger.info(`New client connected: ${clientId}`);

    ws.send(
      JSON.stringify({
        type: "connected",
        clientId,
        version: "1.0.0",
      }),
    );

    ws.on("message", async (data) => {
      try {
        const message = JSON.parse(data.toString());
        logger.debug(`Received message from ${clientId}:`, message);

        const response = await messageHandler.handleMessage(message, clientId);

        ws.send(JSON.stringify(response));
      } catch (error) {
        logger.error(`Error handling message from ${clientId}:`, error);
        ws.send(
          JSON.stringify({
            type: "error",
            error: error instanceof Error ? error.message : "Unknown error",
            requestId: null,
          }),
        );
      }
    });

    ws.on("close", () => {
      logger.info(`Client disconnected: ${clientId}`);
      sessionManager.cleanupClientSessions(clientId);
    });

    ws.on("error", (error) => {
      logger.error(`WebSocket error for ${clientId}:`, error);
    });
  });

  process.on("SIGINT", async () => {
    logger.info("Shutting down server...");
    await sessionManager.cleanup();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    logger.info("Shutting down server...");
    await sessionManager.cleanup();
    process.exit(0);
  });

  logger.info(`Stagehand server listening on port ${PORT}`);
}

startServer().catch((error) => {
  logger.error("Failed to start server:", error);
  process.exit(1);
});
