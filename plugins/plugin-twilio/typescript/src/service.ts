import {
  ChannelType,
  ContentType,
  createMessageMemory,
  createUniqueUuid,
  EventType,
  type HandlerCallback,
  type IAgentRuntime,
  logger,
  type Media,
  type Memory,
  Service,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import bodyParser from "body-parser";
import express, { type Express } from "express";
import NodeCache from "node-cache";
import twilio from "twilio";
import { WebSocketServer } from "ws";
import {
  ERROR_MESSAGES,
  TWILIO_CONSTANTS,
  TWILIO_SERVICE_NAME,
} from "./constants";
import {
  CACHE_KEYS,
  type TwilioCall,
  type TwilioConfig,
  TwilioError,
  TwilioEventType,
  type TwilioMedia,
  type TwilioMessage,
  type TwilioServiceInterface,
  type TwilioSmsWebhook,
  type TwilioStatusWebhook,
  type TwilioVoiceStream,
  type TwilioVoiceWebhook,
} from "./types";
import {
  formatMessagingAddress,
  isWhatsAppAddress,
  stripWhatsAppPrefix,
  validateMessagingAddress,
  validatePhoneNumber,
} from "./utils";

type MessageService = {
  handleMessage: (
    runtime: IAgentRuntime,
    message: Memory,
    callback?: HandlerCallback,
  ) => Promise<void>;
};

const getMessageService = (runtime: IAgentRuntime): MessageService | null => {
  if ("messageService" in runtime) {
    const withMessageService = runtime as IAgentRuntime & {
      messageService?: MessageService | null;
    };
    return withMessageService.messageService ?? null;
  }
  return null;
};

export class TwilioService extends Service implements TwilioServiceInterface {
  static serviceType: string = TWILIO_SERVICE_NAME;

  // Required static methods for Service type
  static async start(runtime: IAgentRuntime): Promise<TwilioService> {
    const service = new TwilioService();
    await service.initialize(runtime);
    return service;
  }

  static async stop(_runtime: IAgentRuntime): Promise<void> {
    // Stop method is handled by instance cleanup
    return;
  }

  private twilioConfig!: TwilioConfig;
  private client!: any; // Twilio client
  private app!: Express;
  private server: any;
  private wss!: WebSocketServer;
  private cache: NodeCache;
  private voiceStreams: Map<string, TwilioVoiceStream>;
  private isInitialized: boolean = false;

  constructor() {
    super();
    this.voiceStreams = new Map();
    this.cache = new NodeCache({ stdTTL: 600 }); // 10 minute default TTL
  }

  async initialize(runtime: IAgentRuntime): Promise<void> {
    if (this.isInitialized) {
      logger.warn("TwilioService already initialized");
      return;
    }

    this.runtime = runtime;

    // Get configuration from runtime
    const configuredPhoneNumber = runtime.getSetting(
      "TWILIO_PHONE_NUMBER",
    ) as string;
    const normalizedPhoneNumber = stripWhatsAppPrefix(
      configuredPhoneNumber || "",
    );

    this.twilioConfig = {
      accountSid: runtime.getSetting("TWILIO_ACCOUNT_SID") as string,
      authToken: runtime.getSetting("TWILIO_AUTH_TOKEN") as string,
      phoneNumber: normalizedPhoneNumber,
      webhookUrl: runtime.getSetting("TWILIO_WEBHOOK_URL") as string,
      webhookPort: parseInt(
        runtime.getSetting("TWILIO_WEBHOOK_PORT") || "3000",
      ),
    };

    // Validate configuration
    if (
      !this.twilioConfig.accountSid ||
      !this.twilioConfig.authToken ||
      !this.twilioConfig.phoneNumber
    ) {
      throw new TwilioError(ERROR_MESSAGES.MISSING_CREDENTIALS);
    }

    // Initialize Twilio client
    this.client = twilio(
      this.twilioConfig.accountSid,
      this.twilioConfig.authToken,
    );

    // Set up webhook server
    await this.setupWebhookServer();

    // Update phone number webhook URLs
    await this.updatePhoneNumberWebhooks();

    this.isInitialized = true;
    logger.info("TwilioService initialized successfully");
  }

  // Implement stop method required by Service interface
  async stop(): Promise<void> {
    await this.cleanup();
  }

  // Add capability description getter
  get capabilityDescription(): string {
    return "Twilio voice and SMS integration service for bidirectional communication";
  }

  private async setupWebhookServer(): Promise<void> {
    this.app = express();

    // Middleware
    this.app.use(bodyParser.urlencoded({ extended: false }));
    this.app.use(bodyParser.json());

    // SMS webhook
    this.app.post(TWILIO_CONSTANTS.WEBHOOK_PATHS.SMS, async (req, res) => {
      try {
        const webhook = req.body as TwilioSmsWebhook;
        await this.handleIncomingSms(webhook);
        res.type("text/xml").send("<Response></Response>");
      } catch (error) {
        logger.error({ error: String(error) }, "Error handling SMS webhook");
        res.status(500).send("<Response></Response>");
      }
    });

    // Voice webhook
    this.app.post(TWILIO_CONSTANTS.WEBHOOK_PATHS.VOICE, async (req, res) => {
      try {
        const webhook = req.body as TwilioVoiceWebhook;
        const twiml = await this.handleIncomingCall(webhook);
        res.type("text/xml").send(twiml);
      } catch (error) {
        logger.error({ error: String(error) }, "Error handling voice webhook");
        res
          .type("text/xml")
          .send(TWILIO_CONSTANTS.TWIML.DEFAULT_VOICE_RESPONSE);
      }
    });

    // Status callback webhook
    this.app.post(TWILIO_CONSTANTS.WEBHOOK_PATHS.STATUS, (req, res) => {
      const webhook = req.body as TwilioStatusWebhook;
      const {
        MessageSid,
        MessageStatus,
        SmsStatus,
        CallSid,
        CallStatus,
        ErrorCode,
        ErrorMessage,
        To,
        From,
        MessagingServiceSid,
        AccountSid,
        ApiVersion,
      } = webhook;
      logger.info(
        {
          MessageSid,
          MessageStatus,
          SmsStatus,
          CallSid,
          CallStatus,
          ErrorCode,
          ErrorMessage,
          To,
          From,
          MessagingServiceSid,
          AccountSid,
          ApiVersion,
        },
        "Status callback received",
      );
      res.sendStatus(200);
    });

    // Start HTTP server
    this.server = this.app.listen(this.twilioConfig.webhookPort, () => {
      logger.info(
        `Twilio webhook server listening on port ${this.twilioConfig.webhookPort}`,
      );
    });

    // Set up WebSocket server for voice streaming
    this.wss = new WebSocketServer({ server: this.server });
    this.setupVoiceStreamingWebSocket();
  }

  private setupVoiceStreamingWebSocket(): void {
    this.wss.on("connection", (ws, req) => {
      const url = new URL(req.url!, `http://${req.headers.host}`);
      const callSid = url.searchParams.get("callSid");

      if (!callSid) {
        logger.error("No callSid provided for voice stream");
        ws.close();
        return;
      }

      logger.info(`Voice stream connected for call ${callSid}`);

      ws.on("message", async (data) => {
        try {
          const message = JSON.parse(data.toString());

          switch (message.event) {
            case "start":
              this.handleStreamStart(callSid, message, ws);
              break;
            case "media":
              this.handleStreamMedia(callSid, message);
              break;
            case "stop":
              this.handleStreamStop(callSid);
              break;
          }
        } catch (error) {
          logger.error(
            { error: String(error) },
            "Error processing voice stream message",
          );
        }
      });

      ws.on("close", () => {
        logger.info(`Voice stream closed for call ${callSid}`);
        this.voiceStreams.delete(callSid);
        // Emit event through runtime if available
        if (this.runtime) {
          this.runtime.emitEvent(TwilioEventType.VOICE_STREAM_ENDED, {
            callSid,
          });
        }
      });
    });
  }

  private handleStreamStart(callSid: string, message: any, ws: any): void {
    const stream: TwilioVoiceStream = {
      streamSid: message.streamSid,
      callSid,
      from: message.start.customParameters.from,
      to: message.start.customParameters.to,
      socket: ws,
    };

    this.voiceStreams.set(callSid, stream);
    if (this.runtime) {
      this.runtime.emitEvent(TwilioEventType.VOICE_STREAM_STARTED, { stream });
    }
  }

  private handleStreamMedia(callSid: string, message: any): void {
    const stream = this.voiceStreams.get(callSid);
    if (!stream) return;

    // Process audio data
    const audioBuffer = Buffer.from(message.media.payload, "base64");

    // Emit audio data for processing by other services
    if (this.runtime) {
      this.runtime.emitEvent("audio:received", {
        callSid,
        audio: audioBuffer,
        timestamp: message.media.timestamp,
      });
    }
  }

  private handleStreamStop(callSid: string): void {
    this.voiceStreams.delete(callSid);
    if (this.runtime) {
      this.runtime.emitEvent(TwilioEventType.VOICE_STREAM_ENDED, { callSid });
    }
  }

  private async updatePhoneNumberWebhooks(): Promise<void> {
    try {
      const phoneNumbers = await this.client.incomingPhoneNumbers.list({
        phoneNumber: this.twilioConfig.phoneNumber,
      });

      if (phoneNumbers.length === 0) {
        throw new TwilioError(
          `Phone number ${this.twilioConfig.phoneNumber} not found`,
        );
      }

      const phoneNumber = phoneNumbers[0];

      await this.client.incomingPhoneNumbers(phoneNumber.sid).update({
        smsUrl: `${this.twilioConfig.webhookUrl}${TWILIO_CONSTANTS.WEBHOOK_PATHS.SMS}`,
        smsMethod: "POST",
        voiceUrl: `${this.twilioConfig.webhookUrl}${TWILIO_CONSTANTS.WEBHOOK_PATHS.VOICE}`,
        voiceMethod: "POST",
        statusCallback: `${this.twilioConfig.webhookUrl}${TWILIO_CONSTANTS.WEBHOOK_PATHS.STATUS}`,
        statusCallbackMethod: "POST",
      });

      logger.info(
        `Updated webhooks for phone number ${this.twilioConfig.phoneNumber}`,
      );
    } catch (error) {
      logger.error(
        { error: String(error) },
        "Error updating phone number webhooks",
      );
      throw error;
    }
  }

  async sendSms(
    to: string,
    body: string,
    mediaUrl?: string[],
    fromOverride?: string,
  ): Promise<TwilioMessage> {
    const normalizedTo = formatMessagingAddress(to);
    if (!normalizedTo || !validateMessagingAddress(normalizedTo)) {
      throw new TwilioError(ERROR_MESSAGES.INVALID_PHONE_NUMBER);
    }

    const normalizedFrom = formatMessagingAddress(
      fromOverride || this.twilioConfig.phoneNumber,
    );
    if (!normalizedFrom) {
      throw new TwilioError(ERROR_MESSAGES.INVALID_PHONE_NUMBER);
    }

    const fromNumber = isWhatsAppAddress(normalizedTo)
      ? `whatsapp:${stripWhatsAppPrefix(normalizedFrom)}`
      : stripWhatsAppPrefix(normalizedFrom);

    try {
      const message = await this.client.messages.create({
        from: fromNumber,
        to: normalizedTo,
        body,
        mediaUrl,
        statusCallback: `${this.twilioConfig.webhookUrl}${TWILIO_CONSTANTS.WEBHOOK_PATHS.STATUS}`,
      });

      const twilioMessage: TwilioMessage = {
        sid: message.sid,
        from: message.from,
        to: message.to,
        body: message.body,
        direction: "outbound",
        status: message.status,
        dateCreated: message.dateCreated,
        dateSent: message.dateSent || undefined,
      };

      // Cache the message
      const conversationKey = CACHE_KEYS.CONVERSATION(normalizedTo);
      let conversationHistory =
        (this.cache.get(conversationKey) as TwilioMessage[]) || [];
      conversationHistory.push(twilioMessage);
      // Keep only last 50 messages
      if (conversationHistory.length > 50) {
        conversationHistory = conversationHistory.slice(-50);
      }
      this.cache.set(
        conversationKey,
        conversationHistory,
        TWILIO_CONSTANTS.CACHE_TTL.CONVERSATION,
      );

      if (this.runtime) {
        this.runtime.emitEvent(TwilioEventType.SMS_SENT, twilioMessage);
      }
      return twilioMessage;
    } catch (error: any) {
      throw new TwilioError(
        `Failed to send SMS: ${error.message}`,
        error.code,
        error.moreInfo,
      );
    }
  }

  async makeCall(
    to: string,
    twiml?: string,
    url?: string,
  ): Promise<TwilioCall> {
    if (!validatePhoneNumber(to)) {
      throw new TwilioError(ERROR_MESSAGES.INVALID_PHONE_NUMBER);
    }

    try {
      const callParams: any = {
        from: this.twilioConfig.phoneNumber,
        to,
        statusCallback: `${this.twilioConfig.webhookUrl}${TWILIO_CONSTANTS.WEBHOOK_PATHS.STATUS}`,
        statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
      };

      if (twiml) {
        callParams.twiml = twiml;
      } else if (url) {
        callParams.url = url;
      } else {
        callParams.twiml = TWILIO_CONSTANTS.TWIML.DEFAULT_VOICE_RESPONSE;
      }

      const call = await this.client.calls.create(callParams);

      const twilioCall: TwilioCall = {
        sid: call.sid,
        from: call.from,
        to: call.to,
        status: call.status,
        direction: "outbound",
        dateCreated: call.dateCreated,
      };

      // Cache call state
      this.cache.set(
        CACHE_KEYS.CALL_STATE(call.sid),
        twilioCall,
        TWILIO_CONSTANTS.CACHE_TTL.CALL_STATE,
      );

      return twilioCall;
    } catch (error: any) {
      throw new TwilioError(
        `Failed to make call: ${error.message}`,
        error.code,
        error.moreInfo,
      );
    }
  }

  async handleIncomingSms(webhook: TwilioSmsWebhook): Promise<void> {
    const message: TwilioMessage = {
      sid: webhook.MessageSid,
      from: webhook.From,
      to: webhook.To,
      body: webhook.Body,
      direction: "inbound",
      status: "received",
      dateCreated: new Date(),
    };

    // Handle media if present
    if (webhook.NumMedia && parseInt(webhook.NumMedia) > 0) {
      message.media = [];
      // Twilio sends media as MediaUrl0, MediaUrl1, etc.
      for (let i = 0; i < parseInt(webhook.NumMedia); i++) {
        const mediaUrl = (webhook as any)[`MediaUrl${i}`];
        const contentType = (webhook as any)[`MediaContentType${i}`];
        if (mediaUrl) {
          message.media.push({
            url: mediaUrl,
            contentType: contentType || "unknown",
            sid: `media_${i}`,
          });
        }
      }
    }

    // Store in cache for conversation context
    const conversationKey = CACHE_KEYS.CONVERSATION(webhook.From);
    let conversationHistory =
      (this.cache.get(conversationKey) as TwilioMessage[]) || [];
    conversationHistory.push(message);
    // Keep only last 50 messages
    if (conversationHistory.length > 50) {
      conversationHistory = conversationHistory.slice(-50);
    }
    this.cache.set(
      conversationKey,
      conversationHistory,
      TWILIO_CONSTANTS.CACHE_TTL.CONVERSATION,
    );

    if (this.runtime) {
      this.runtime.emitEvent(TwilioEventType.SMS_RECEIVED, message);
    }

    // Process message with agent runtime
    await this.processIncomingMessage(message);
  }

  async handleIncomingCall(webhook: TwilioVoiceWebhook): Promise<string> {
    const call: TwilioCall = {
      sid: webhook.CallSid,
      from: webhook.From,
      to: webhook.To,
      status: webhook.CallStatus,
      direction: "inbound",
      dateCreated: new Date(),
    };

    // Cache call state
    this.cache.set(
      CACHE_KEYS.CALL_STATE(webhook.CallSid),
      call,
      TWILIO_CONSTANTS.CACHE_TTL.CALL_STATE,
    );

    if (this.runtime) {
      this.runtime.emitEvent(TwilioEventType.CALL_RECEIVED, call);
    }

    // Generate TwiML response for voice streaming
    const streamUrl = `wss://${new URL(this.twilioConfig.webhookUrl).host}${TWILIO_CONSTANTS.WEBHOOK_PATHS.VOICE_STREAM}?callSid=${webhook.CallSid}`;
    return TWILIO_CONSTANTS.TWIML.STREAM_RESPONSE(streamUrl);
  }

  async startVoiceStream(callSid: string): Promise<void> {
    const stream = this.voiceStreams.get(callSid);
    if (!stream) {
      throw new TwilioError(`No voice stream found for call ${callSid}`);
    }

    // Start streaming audio processing
    logger.info(`Starting voice stream processing for call ${callSid}`);
  }

  async endVoiceStream(callSid: string): Promise<void> {
    const stream = this.voiceStreams.get(callSid);
    if (stream && stream.socket) {
      stream.socket.close();
    }
    this.voiceStreams.delete(callSid);
  }

  private async processIncomingMessage(message: TwilioMessage): Promise<void> {
    try {
      const text = message.body?.trim();
      if (!text) {
        return;
      }

      const source = isWhatsAppAddress(message.from) ? "whatsapp" : "twilio";
      const entityId = createUniqueUuid(this.runtime, message.from);
      const roomId = createUniqueUuid(this.runtime, `twilio:${message.from}`);
      const worldId = createUniqueUuid(this.runtime, `twilio:${message.to}`);
      await this.runtime.ensureConnection({
        entityId,
        roomId,
        worldId,
        userName: message.from,
        source,
        channelId: message.from,
        type: ChannelType.DM,
      });

      const attachments = this.buildMediaAttachments(message.media);
      const memory = createMessageMemory({
        id: stringToUuid(message.sid),
        entityId,
        roomId,
        content: {
          text,
          source,
          channelType: ChannelType.DM,
          phoneNumber: message.from,
          attachments: attachments.length > 0 ? attachments : undefined,
        },
      });

      const callback: HandlerCallback = async (content) => {
        const responseText =
          typeof content.text === "string" ? content.text.trim() : "";
        if (!responseText) {
          return [];
        }

        await this.sendSms(message.from, responseText, undefined, message.to);
        return [];
      };

      const messageService = getMessageService(this.runtime);
      if (messageService) {
        await messageService.handleMessage(this.runtime, memory, callback);
      } else {
        logger.warn("messageService unavailable; falling back to event emit");
        await this.runtime.emitEvent(EventType.MESSAGE_RECEIVED, {
          message: memory,
          callback,
          source,
        });
      }
    } catch (error) {
      logger.error(
        { error: String(error) },
        "Error processing incoming message",
      );
    }
  }

  private buildMediaAttachments(media?: TwilioMedia[]): Media[] {
    if (!media || media.length === 0) {
      return [];
    }

    return media.map((item) => ({
      id: item.sid,
      url: item.url,
      contentType: this.resolveContentType(item.contentType),
    }));
  }

  private resolveContentType(contentType: string): ContentType | undefined {
    if (contentType.startsWith("image/")) {
      return ContentType.IMAGE;
    }
    if (contentType.startsWith("video/")) {
      return ContentType.VIDEO;
    }
    if (contentType.startsWith("audio/")) {
      return ContentType.AUDIO;
    }
    return ContentType.DOCUMENT;
  }

  sendStreamAudio(callSid: string, audio: Buffer): void {
    const stream = this.voiceStreams.get(callSid);
    if (!stream || !stream.socket) return;

    // Convert audio to base64 and send via WebSocket
    const payload = {
      event: "media",
      streamSid: stream.streamSid,
      media: {
        payload: audio.toString("base64"),
      },
    };

    stream.socket.send(JSON.stringify(payload));
  }

  async cleanup(): Promise<void> {
    // Close all voice streams
    for (const [callSid, stream] of this.voiceStreams) {
      if (stream.socket) {
        stream.socket.close();
      }
    }
    this.voiceStreams.clear();

    // Close WebSocket server
    if (this.wss) {
      this.wss.close();
    }

    // Close HTTP server
    if (this.server) {
      this.server.close();
    }

    // Clear cache
    this.cache.flushAll();

    this.isInitialized = false;
    logger.info("TwilioService cleaned up");
  }

  // Getters for service information
  get serviceType(): string {
    return TWILIO_SERVICE_NAME;
  }

  get serviceName(): string {
    return "twilio";
  }

  get phoneNumber(): string {
    return this.twilioConfig.phoneNumber;
  }

  get isConnected(): boolean {
    return this.isInitialized;
  }

  // Add public method to get conversation history
  getConversationHistory(
    phoneNumber: string,
    limit: number = 10,
  ): TwilioMessage[] {
    const cacheKey = CACHE_KEYS.CONVERSATION(phoneNumber);
    const messages = this.cache.get(cacheKey) as TwilioMessage[];

    if (!messages || !Array.isArray(messages)) {
      return [];
    }

    return messages.slice(-limit);
  }

  // Add method to get call state
  getCallState(callSid: string): TwilioCall | undefined {
    const cacheKey = CACHE_KEYS.CALL_STATE(callSid);
    return this.cache.get(cacheKey) as TwilioCall | undefined;
  }
}
