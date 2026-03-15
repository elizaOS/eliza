import {
  ChannelType,
  type Content,
  createUniqueUuid,
  type EventPayload,
  type IAgentRuntime,
  logger,
  Service,
  type TargetInfo,
  type UUID,
} from "@elizaos/core";
import {
  createProxyFetch,
  getOAInfo,
  parseWebhookUpdate,
  sendImage,
  sendMessage,
  type ZaloFetch,
} from "./client";
import {
  DEFAULT_POLLING_TIMEOUT,
  DEFAULT_WEBHOOK_PATH,
  DEFAULT_WEBHOOK_PORT,
  MAX_MESSAGE_LENGTH,
  ZALO_SERVICE_NAME,
} from "./constants";
import {
  buildZaloSettings,
  validateZaloConfig,
  type ZaloSettings,
} from "./environment";
import {
  type ZaloBotProbe,
  type ZaloContent,
  ZaloEventTypes,
  type ZaloMessage,
  type ZaloOAInfo,
  type ZaloUpdate,
} from "./types";

/**
 * Zalo service for elizaOS
 */
export class ZaloService extends Service {
  static serviceType = ZALO_SERVICE_NAME;
  capabilityDescription =
    "The agent is able to send and receive messages on Zalo";

  private settings: ZaloSettings | null = null;
  private oaInfo: ZaloOAInfo | null = null;
  private fetcher: ZaloFetch | null = null;
  private webhookServer: ReturnType<typeof import("http").createServer> | null =
    null;
  private pollingAbortController: AbortController | null = null;
  private isRunning = false;

  /**
   * Get the current OA info
   */
  getOAInfo(): ZaloOAInfo | null {
    return this.oaInfo;
  }

  /**
   * Get the current settings
   */
  getSettings(): ZaloSettings | null {
    return this.settings;
  }

  /**
   * Probe the Zalo OA connection for health checks
   */
  async probeZalo(timeoutMs = 5000): Promise<ZaloBotProbe> {
    if (!this.settings) {
      return {
        ok: false,
        error: "Service not initialized",
        latencyMs: 0,
      };
    }

    const startTime = Date.now();

    try {
      const response = await getOAInfo(
        this.settings.accessToken,
        timeoutMs,
        this.fetcher ?? undefined,
      );
      const latencyMs = Date.now() - startTime;

      return {
        ok: true,
        oa: response.data,
        latencyMs,
      };
    } catch (error) {
      const latencyMs = Date.now() - startTime;
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        latencyMs,
      };
    }
  }

  /**
   * Start the Zalo service
   */
  static async start(runtime: IAgentRuntime): Promise<ZaloService> {
    const service = new ZaloService(runtime);

    // Validate and load configuration
    const config = await validateZaloConfig(runtime);
    if (!config) {
      logger.warn("Zalo configuration not valid - service will not start");
      return service;
    }

    service.settings = buildZaloSettings(config);

    if (!service.settings.enabled) {
      logger.info("Zalo service is disabled");
      return service;
    }

    // Set up proxy if configured
    if (service.settings.proxyUrl) {
      service.fetcher = createProxyFetch(service.settings.proxyUrl);
    }

    // Get OA info
    try {
      const probe = await service.probeZalo(5000);
      if (probe.ok && probe.oa) {
        service.oaInfo = probe.oa;
        logger.info(
          `Zalo OA connected: ${probe.oa.name} (ID: ${probe.oa.oaId})`,
        );
      } else {
        logger.warn(`Zalo OA probe failed: ${probe.error}`);
      }
    } catch (error) {
      logger.warn(`Failed to get Zalo OA info: ${error}`);
    }

    // Start based on update mode
    if (
      service.settings.updateMode === "webhook" &&
      service.settings.webhookUrl
    ) {
      await service.startWebhook();
    } else {
      await service.startPolling();
    }

    service.isRunning = true;

    // Emit bot started event
    service.runtime.emitEvent(ZaloEventTypes.BOT_STARTED, {
      runtime: service.runtime,
      oaId: service.oaInfo?.oaId,
      oaName: service.oaInfo?.name,
      updateMode: service.settings.updateMode,
      timestamp: Date.now(),
    } as EventPayload);

    logger.success(`Zalo service started for ${runtime.character.name}`);
    return service;
  }

  /**
   * Stop the Zalo service
   */
  static async stop(runtime: IAgentRuntime): Promise<void> {
    const service = (await runtime.getService(ZALO_SERVICE_NAME)) as
      | ZaloService
      | undefined;
    if (service) {
      await service.stop();
    }
  }

  /**
   * Stop the service
   */
  async stop(): Promise<void> {
    // Emit bot stopped event
    this.runtime.emitEvent(ZaloEventTypes.BOT_STOPPED, {
      runtime: this.runtime,
      oaId: this.oaInfo?.oaId,
      oaName: this.oaInfo?.name,
      updateMode: this.settings?.updateMode || "polling",
      timestamp: Date.now(),
    } as EventPayload);

    // Stop polling
    if (this.pollingAbortController) {
      this.pollingAbortController.abort();
      this.pollingAbortController = null;
    }

    // Stop webhook server
    if (this.webhookServer) {
      await new Promise<void>((resolve) => {
        this.webhookServer?.close(() => resolve());
      });
      this.webhookServer = null;
    }

    this.isRunning = false;
    logger.info("Zalo service stopped");
  }

  /**
   * Start webhook mode
   */
  private async startWebhook(): Promise<void> {
    if (!this.settings?.webhookUrl) {
      throw new Error("Webhook URL not configured");
    }

    const webhookPath = this.settings.webhookPath || DEFAULT_WEBHOOK_PATH;
    const webhookPort = this.settings.webhookPort || DEFAULT_WEBHOOK_PORT;

    const http = await import("node:http");

    this.webhookServer = http.createServer(async (req, res) => {
      if (req.url === webhookPath && req.method === "POST") {
        let body = "";
        req.on("data", (chunk) => {
          body += chunk.toString();
        });
        req.on("end", async () => {
          try {
            const data = JSON.parse(body);
            const update = parseWebhookUpdate(data);
            if (update) {
              await this.handleUpdate(update);
            }
            res.writeHead(200);
            res.end("OK");
          } catch (error) {
            logger.error({ error }, "Error processing Zalo webhook");
            res.writeHead(500);
            res.end("Error");
          }
        });
      } else if (req.url === "/health" || req.url === "/") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", oa: this.oaInfo?.name }));
      } else {
        res.writeHead(404);
        res.end("Not Found");
      }
    });

    this.webhookServer.listen(webhookPort, () => {
      logger.info(`Zalo webhook server listening on port ${webhookPort}`);
      logger.info(`Webhook URL: ${this.settings?.webhookUrl}${webhookPath}`);
    });

    this.runtime.emitEvent(ZaloEventTypes.WEBHOOK_REGISTERED, {
      runtime: this.runtime,
      url: `${this.settings.webhookUrl}${webhookPath}`,
      path: webhookPath,
      port: webhookPort,
      timestamp: Date.now(),
    } as EventPayload);
  }

  /**
   * Start polling mode (development only)
   */
  private async startPolling(): Promise<void> {
    logger.info("Zalo polling mode started (for development only)");
    this.pollingAbortController = new AbortController();

    // Note: Zalo OA API doesn't have a native long-polling endpoint
    // In production, use webhooks. This is a placeholder for development.
    const pollInterval = setInterval(async () => {
      if (this.pollingAbortController?.signal.aborted) {
        clearInterval(pollInterval);
        return;
      }
      // Polling implementation would go here if Zalo supported it
    }, DEFAULT_POLLING_TIMEOUT * 1000);
  }

  /**
   * Handle an incoming update
   */
  private async handleUpdate(update: ZaloUpdate): Promise<void> {
    if (update.message) {
      await this.handleMessage(update.message);
    }

    if (update.eventName === "follow" && update.userId) {
      this.runtime.emitEvent(ZaloEventTypes.USER_FOLLOWED, {
        runtime: this.runtime,
        userId: update.userId,
        action: "follow",
        timestamp: update.timestamp || Date.now(),
      } as EventPayload);
    }

    if (update.eventName === "unfollow" && update.userId) {
      this.runtime.emitEvent(ZaloEventTypes.USER_UNFOLLOWED, {
        runtime: this.runtime,
        userId: update.userId,
        action: "unfollow",
        timestamp: update.timestamp || Date.now(),
      } as EventPayload);
    }
  }

  /**
   * Handle an incoming message
   */
  private async handleMessage(message: ZaloMessage): Promise<void> {
    const userId = message.from.id;
    const entityId = createUniqueUuid(this.runtime, userId) as UUID;
    const roomId = createUniqueUuid(this.runtime, userId) as UUID;
    const worldId = createUniqueUuid(
      this.runtime,
      this.oaInfo?.oaId || "zalo",
    ) as UUID;

    // Ensure connection exists
    await this.runtime.ensureConnection({
      entityId,
      roomId,
      userName: message.from.name,
      userId: userId as UUID,
      name: message.from.name || "Zalo User",
      source: "zalo",
      channelId: userId,
      messageServerId: worldId,
      type: ChannelType.DM,
      worldId,
    });

    // Emit message received event
    this.runtime.emitEvent(ZaloEventTypes.MESSAGE_RECEIVED, {
      runtime: this.runtime,
      originalMessage: message,
      source: "zalo",
    } as EventPayload);
  }

  /**
   * Send a text message
   */
  async sendTextMessage(userId: string, text: string): Promise<string | null> {
    if (!this.settings) {
      throw new Error("Zalo service not initialized");
    }

    // Truncate to max length
    const truncatedText = text.slice(0, MAX_MESSAGE_LENGTH);

    try {
      const response = await sendMessage(
        this.settings.accessToken,
        { userId, text: truncatedText },
        this.fetcher ?? undefined,
      );

      this.runtime.emitEvent(ZaloEventTypes.MESSAGE_SENT, {
        runtime: this.runtime,
        userId,
        messageId: response.data?.message_id,
        text: truncatedText,
        success: true,
      } as EventPayload);

      return response.data?.message_id || null;
    } catch (error) {
      logger.error({ error }, `Failed to send Zalo message to ${userId}`);
      return null;
    }
  }

  /**
   * Send an image message
   */
  async sendImageMessage(
    userId: string,
    imageUrl: string,
    caption?: string,
  ): Promise<string | null> {
    if (!this.settings) {
      throw new Error("Zalo service not initialized");
    }

    try {
      const response = await sendImage(
        this.settings.accessToken,
        { userId, imageUrl, caption },
        this.fetcher ?? undefined,
      );

      return response.data?.message_id || null;
    } catch (error) {
      logger.error({ error }, `Failed to send Zalo image to ${userId}`);
      return null;
    }
  }

  /**
   * Register send handler for cross-service communication
   */
  static registerSendHandlers(
    runtime: IAgentRuntime,
    serviceInstance: ZaloService,
  ): void {
    runtime.registerSendHandler(
      "zalo",
      serviceInstance.handleSendMessage.bind(serviceInstance),
    );
    logger.info("[Zalo] Registered send handler");
  }

  /**
   * Handle send message from other services
   */
  async handleSendMessage(
    runtime: IAgentRuntime,
    target: TargetInfo,
    content: Content,
  ): Promise<void> {
    let userId: string | undefined;

    if (target.channelId) {
      userId = target.channelId;
    } else if (target.roomId) {
      const room = await runtime.getRoom(target.roomId);
      userId = room?.channelId;
    }

    if (!userId) {
      throw new Error("Could not determine Zalo user ID from target");
    }

    const zaloContent = content as ZaloContent;

    if (zaloContent.imageUrl) {
      await this.sendImageMessage(
        userId,
        zaloContent.imageUrl,
        zaloContent.caption,
      );
    } else if (content.text) {
      await this.sendTextMessage(userId, content.text);
    }
  }
}
