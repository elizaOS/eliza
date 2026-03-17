import http from "node:http";
import { URL } from "node:url";
import {
  type Content,
  type EventPayload,
  type IAgentRuntime,
  logger,
  Service,
  type TargetInfo,
} from "@elizaos/core";
import { CallManager } from "./client";
import { VOICE_CALL_SERVICE_NAME } from "./constants";
import {
  buildVoiceCallSettings,
  type VoiceCallSettings,
  validateProviderConfig,
  validateVoiceCallConfig,
} from "./environment";
import { createProvider, type VoiceCallProvider } from "./providers";
import {
  type CallId,
  type CallRecord,
  type NormalizedEvent,
  type OutboundCallOptions,
  TerminalStates,
  type VoiceCallContent,
  VoiceCallEventTypes,
  type VoiceCallServiceProbe,
  type WebhookContext,
} from "./types";

const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024;

export class VoiceCallService extends Service {
  static serviceType = VOICE_CALL_SERVICE_NAME;
  capabilityDescription = "The agent is able to make and receive voice calls";

  private settings: VoiceCallSettings | null = null;
  private provider: VoiceCallProvider | null = null;
  private callManager: CallManager | null = null;
  private webhookServer: http.Server | null = null;
  private webhookUrl: string | null = null;

  /**
   * Get the current settings.
   */
  getSettings(): VoiceCallSettings | null {
    return this.settings;
  }

  /**
   * Get the call manager.
   */
  getCallManager(): CallManager | null {
    return this.callManager;
  }

  /**
   * Get the provider.
   */
  getProvider(): VoiceCallProvider | null {
    return this.provider;
  }

  /**
   * Probe the service for health checks.
   */
  async probeService(_timeoutMs: number = 5000): Promise<VoiceCallServiceProbe> {
    const startTime = Date.now();

    if (!this.settings || !this.provider) {
      return {
        ok: false,
        error: "Service not initialized",
        latencyMs: Date.now() - startTime,
      };
    }

    return {
      ok: true,
      provider: this.settings.provider,
      webhookUrl: this.webhookUrl || undefined,
      activeCalls: this.callManager?.getActiveCalls().length || 0,
      latencyMs: Date.now() - startTime,
    };
  }

  /**
   * Initiate an outbound call.
   */
  async initiateCall(
    to: string,
    options?: OutboundCallOptions
  ): Promise<{ callId: CallId; success: boolean; error?: string }> {
    if (!this.provider || !this.callManager || !this.webhookUrl) {
      return { callId: "", success: false, error: "Service not initialized" };
    }

    if (this.callManager.isAtMaxConcurrentCalls()) {
      return {
        callId: "",
        success: false,
        error: `Maximum concurrent calls (${this.settings?.maxConcurrentCalls}) reached`,
      };
    }

    const { callId, record: _record } = this.callManager.createOutboundCall(to, options);

    try {
      // Generate TwiML for notify mode if needed
      let inlineTwiml: string | undefined;
      const mode = options?.mode ?? this.settings?.outbound.defaultMode ?? "notify";
      if (mode === "notify" && options?.message && "generateNotifyTwiml" in this.provider) {
        inlineTwiml = (
          this.provider as { generateNotifyTwiml: (msg: string, voice?: string) => string }
        ).generateNotifyTwiml(options.message);
      }

      const result = await this.provider.initiateCall({
        callId,
        from: this.settings?.fromNumber,
        to,
        webhookUrl: this.webhookUrl,
        inlineTwiml,
      });

      this.callManager.updateProviderCallId(callId, result.providerCallId);

      this.runtime.emitEvent(
        VoiceCallEventTypes.CALL_INITIATED as string,
        {
          runtime: this.runtime,
          callId,
          providerCallId: result.providerCallId,
          direction: "outbound",
          from: this.settings?.fromNumber,
          to,
          state: "initiated",
          timestamp: Date.now(),
        } as EventPayload
      );

      return { callId, success: true };
    } catch (err) {
      this.callManager.markEnded(callId, "failed");
      return {
        callId,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Speak to the user in an active call.
   */
  async speak(callId: CallId, text: string): Promise<{ success: boolean; error?: string }> {
    const call = this.callManager?.getCall(callId);
    if (!call || !this.provider) {
      return { success: false, error: "Call not found" };
    }

    if (!call.providerCallId) {
      return { success: false, error: "Call not connected" };
    }

    if (TerminalStates.has(call.state)) {
      return { success: false, error: "Call has ended" };
    }

    try {
      this.callManager?.updateState(callId, "speaking");
      this.callManager?.addTranscriptEntry(callId, "bot", text);

      await this.provider.playTts({
        callId,
        providerCallId: call.providerCallId,
        text,
        voice: this.settings?.tts?.voice,
      });

      return { success: true };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Continue call: speak prompt, then wait for user's transcript.
   */
  async continueCall(
    callId: CallId,
    prompt: string
  ): Promise<{ success: boolean; transcript?: string; error?: string }> {
    const call = this.callManager?.getCall(callId);
    if (!call || !this.provider || !this.callManager) {
      return { success: false, error: "Call not found" };
    }

    if (!call.providerCallId) {
      return { success: false, error: "Call not connected" };
    }

    if (TerminalStates.has(call.state)) {
      return { success: false, error: "Call has ended" };
    }

    try {
      await this.speak(callId, prompt);

      this.callManager.updateState(callId, "listening");

      await this.provider.startListening({
        callId,
        providerCallId: call.providerCallId,
      });

      const transcript = await this.callManager.waitForFinalTranscript(callId);

      await this.provider.stopListening({
        callId,
        providerCallId: call.providerCallId,
      });

      return { success: true, transcript };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * End an active call.
   */
  async endCall(callId: CallId): Promise<{ success: boolean; error?: string }> {
    const call = this.callManager?.getCall(callId);
    if (!call || !this.provider) {
      return { success: false, error: "Call not found" };
    }

    if (!call.providerCallId) {
      return { success: false, error: "Call not connected" };
    }

    if (TerminalStates.has(call.state)) {
      return { success: true }; // Already ended
    }

    try {
      await this.provider.hangupCall({
        callId,
        providerCallId: call.providerCallId,
        reason: "hangup-bot",
      });

      this.callManager?.markEnded(callId, "hangup-bot");

      this.runtime.emitEvent(
        VoiceCallEventTypes.CALL_ENDED as string,
        {
          runtime: this.runtime,
          callId,
          providerCallId: call.providerCallId,
          direction: call.direction,
          from: call.from,
          to: call.to,
          state: "hangup-bot",
          timestamp: Date.now(),
        } as EventPayload
      );

      return { success: true };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Check if the service is connected and ready.
   */
  isConnected(): boolean {
    return !!(this.settings && this.provider && this.callManager);
  }

  /**
   * Get an active call by ID.
   */
  getCall(callId: CallId): CallRecord | undefined {
    return this.callManager?.getCall(callId);
  }

  /**
   * Get all active calls.
   */
  getActiveCalls(): CallRecord[] {
    return this.callManager?.getActiveCalls() || [];
  }

  /**
   * Get call status by ID.
   */
  getCallStatus(callId: CallId): { found: boolean; call?: CallRecord } {
    const call = this.callManager?.getCall(callId);
    return { found: !!call, call };
  }

  /**
   * Get call history (completed calls).
   */
  getCallHistory(limit = 50): CallRecord[] {
    return this.callManager?.getCallHistory(limit) || [];
  }

  static async start(runtime: IAgentRuntime): Promise<VoiceCallService> {
    const service = new VoiceCallService(runtime);

    // Load and validate configuration
    const config = await validateVoiceCallConfig(runtime);
    if (!config || !config.VOICE_CALL_PROVIDER) {
      logger.warn("Voice Call service started without configuration - no VOICE_CALL_PROVIDER");
      return service;
    }

    service.settings = buildVoiceCallSettings(config);

    // Validate provider configuration
    const validation = validateProviderConfig(service.settings);
    if (!validation.valid) {
      logger.error(`Voice Call configuration errors:\n${validation.errors.join("\n")}`);
      return service;
    }

    try {
      // Create provider
      service.provider = createProvider(service.settings, {
        skipVerification: service.settings.skipSignatureVerification,
      });

      // Create call manager
      service.callManager = new CallManager(service.settings);

      // Start webhook server
      service.webhookUrl = await service.startWebhookServer();
      service.callManager.initialize(service.webhookUrl);

      // Set public URL on provider if available
      if (service.settings.publicUrl && service.provider.setPublicUrl) {
        service.provider.setPublicUrl(service.settings.publicUrl);
      }

      logger.success(
        `Voice Call service started for ${runtime.character.name} (provider: ${service.settings.provider})`
      );

      service.runtime.emitEvent(
        VoiceCallEventTypes.SERVICE_STARTED as string,
        {
          runtime: service.runtime,
          provider: service.settings.provider,
          webhookUrl: service.webhookUrl,
          activeCalls: 0,
          timestamp: Date.now(),
        } as EventPayload
      );

      return service;
    } catch (error) {
      logger.error(`Failed to start Voice Call service: ${error}`);
      return service;
    }
  }

  static async stop(runtime: IAgentRuntime) {
    const service = runtime.getService(VOICE_CALL_SERVICE_NAME);
    if (service) {
      await service.stop();
    }
  }

  async stop(): Promise<void> {
    // End all active calls
    const activeCalls = this.callManager?.getActiveCalls() || [];
    for (const call of activeCalls) {
      await this.endCall(call.callId);
    }

    // Stop webhook server
    if (this.webhookServer) {
      await new Promise<void>((resolve) => {
        this.webhookServer?.close(() => resolve());
      });
      this.webhookServer = null;
    }

    this.runtime.emitEvent(
      VoiceCallEventTypes.SERVICE_STOPPED as string,
      {
        runtime: this.runtime,
        provider: this.settings?.provider || "unknown",
        webhookUrl: this.webhookUrl || undefined,
        activeCalls: 0,
        timestamp: Date.now(),
      } as EventPayload
    );

    logger.info("Voice Call service stopped");
  }

  private async startWebhookServer(): Promise<string> {
    const { port, bind, path: webhookPath } = this.settings!.serve;

    return new Promise((resolve, reject) => {
      this.webhookServer = http.createServer((req, res) => {
        this.handleWebhookRequest(req, res, webhookPath).catch((err) => {
          logger.error(`Webhook error: ${err}`);
          res.statusCode = 500;
          res.end("Internal Server Error");
        });
      });

      this.webhookServer.on("error", reject);

      this.webhookServer.listen(port, bind, () => {
        const localUrl = `http://${bind}:${port}${webhookPath}`;
        const publicUrl = this.settings?.publicUrl
          ? `${this.settings.publicUrl}${webhookPath}`
          : localUrl;

        logger.info(`Voice Call webhook server listening on ${localUrl}`);

        this.runtime.emitEvent(
          VoiceCallEventTypes.WEBHOOK_REGISTERED as string,
          {
            runtime: this.runtime,
            url: publicUrl,
            path: webhookPath,
            port,
            timestamp: Date.now(),
          } as EventPayload
        );

        resolve(publicUrl);
      });
    });
  }

  private async handleWebhookRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    webhookPath: string
  ): Promise<void> {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);

    if (!url.pathname.startsWith(webhookPath)) {
      res.statusCode = 404;
      res.end("Not Found");
      return;
    }

    if (req.method !== "POST") {
      res.statusCode = 405;
      res.end("Method Not Allowed");
      return;
    }

    let body = "";
    try {
      body = await this.readBody(req, MAX_WEBHOOK_BODY_BYTES);
    } catch (err) {
      if (err instanceof Error && err.message === "PayloadTooLarge") {
        res.statusCode = 413;
        res.end("Payload Too Large");
        return;
      }
      throw err;
    }

    const ctx: WebhookContext = {
      headers: req.headers as Record<string, string | string[] | undefined>,
      rawBody: body,
      url: `http://${req.headers.host}${req.url}`,
      method: "POST",
      query: Object.fromEntries(url.searchParams),
      remoteAddress: req.socket.remoteAddress ?? undefined,
    };

    // Verify signature
    const verification = this.provider?.verifyWebhook(ctx);
    if (!verification.ok) {
      logger.warn(`Webhook verification failed: ${verification.reason}`);
      res.statusCode = 401;
      res.end("Unauthorized");
      return;
    }

    // Parse events
    const result = this.provider?.parseWebhookEvent(ctx);

    // Process each event
    for (const event of result.events) {
      this.processEvent(event);
    }

    // Send response
    res.statusCode = result.statusCode || 200;

    if (result.providerResponseHeaders) {
      for (const [key, value] of Object.entries(result.providerResponseHeaders)) {
        res.setHeader(key, value);
      }
    }

    res.end(result.providerResponseBody || "OK");
  }

  private processEvent(event: NormalizedEvent): void {
    const call = this.callManager?.processEvent(event);

    if (!call) return;

    // Emit appropriate event
    const basePayload = {
      runtime: this.runtime,
      callId: call.callId,
      providerCallId: call.providerCallId,
      direction: call.direction,
      from: call.from,
      to: call.to,
      state: call.state,
      timestamp: Date.now(),
    };

    switch (event.type) {
      case "call.initiated":
        this.runtime.emitEvent(
          VoiceCallEventTypes.CALL_INITIATED as string,
          basePayload as EventPayload
        );
        break;
      case "call.ringing":
        this.runtime.emitEvent(
          VoiceCallEventTypes.CALL_RINGING as string,
          basePayload as EventPayload
        );
        break;
      case "call.answered":
        this.runtime.emitEvent(
          VoiceCallEventTypes.CALL_ANSWERED as string,
          basePayload as EventPayload
        );
        // Auto-speak inbound greeting when an inbound call is answered
        if (call.direction === "inbound" && call.metadata?.initialMessage) {
          const greeting = call.metadata.initialMessage as string;
          this.speak(call.callId, greeting).catch((err) => {
            logger.warn(`Failed to speak inbound greeting: ${err}`);
          });
        }
        break;
      case "call.active":
        this.runtime.emitEvent(
          VoiceCallEventTypes.CALL_ACTIVE as string,
          basePayload as EventPayload
        );
        break;
      case "call.speaking":
        this.runtime.emitEvent(
          VoiceCallEventTypes.CALL_SPEAKING as string,
          basePayload as EventPayload
        );
        break;
      case "call.speech":
        this.runtime.emitEvent(
          VoiceCallEventTypes.CALL_SPEECH as string,
          {
            ...basePayload,
            transcript: event.transcript,
            isFinal: event.isFinal,
            confidence: event.confidence,
          } as EventPayload
        );
        break;
      case "call.dtmf":
        this.runtime.emitEvent(
          VoiceCallEventTypes.CALL_DTMF as string,
          {
            ...basePayload,
            digits: event.digits,
          } as EventPayload
        );
        break;
      case "call.ended":
        this.runtime.emitEvent(
          VoiceCallEventTypes.CALL_ENDED as string,
          basePayload as EventPayload
        );
        break;
      case "call.error":
        this.runtime.emitEvent(
          VoiceCallEventTypes.CALL_ERROR as string,
          {
            ...basePayload,
            error: event.error,
          } as EventPayload
        );
        break;
    }
  }

  private readBody(req: http.IncomingMessage, maxBytes: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      req.on("data", (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes > maxBytes) {
          req.destroy();
          reject(new Error("PayloadTooLarge"));
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
      req.on("error", reject);
    });
  }

  /**
   * Register send handler for the voice call service.
   */
  static registerSendHandlers(runtime: IAgentRuntime, serviceInstance: VoiceCallService) {
    if (serviceInstance?.provider) {
      runtime.registerSendHandler(
        "voice-call",
        serviceInstance.handleSendMessage.bind(serviceInstance)
      );
      logger.info("[Voice Call] Registered send handler.");
    } else {
      logger.warn("[Voice Call] Cannot register send handler - service not initialized.");
    }
  }

  async handleSendMessage(
    _runtime: IAgentRuntime,
    target: TargetInfo,
    content: Content
  ): Promise<void> {
    if (!this.provider || !this.settings) {
      throw new Error("Voice Call service is not initialized.");
    }

    const voiceContent = content as VoiceCallContent;
    const phoneNumber = voiceContent.phoneNumber || target.channelId;

    if (!phoneNumber) {
      throw new Error("Phone number is required for voice call");
    }

    const result = await this.initiateCall(phoneNumber, {
      message: voiceContent.message || content.text,
      mode: voiceContent.mode,
    });

    if (!result.success) {
      throw new Error(result.error || "Failed to initiate call");
    }

    logger.info(
      `[Voice Call SendHandler] Call initiated to ${phoneNumber}, callId: ${result.callId}`
    );
  }
}
