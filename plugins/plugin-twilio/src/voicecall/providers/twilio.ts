import crypto from "node:crypto";
import type { TwilioProviderConfig } from "../environment";
import type {
  HangupCallInput,
  InitiateCallInput,
  InitiateCallResult,
  NormalizedEvent,
  PlayTtsInput,
  ProviderWebhookParseResult,
  StartListeningInput,
  StopListeningInput,
  WebhookContext,
  WebhookVerificationResult,
} from "../types";
import type { VoiceCallProvider } from "./base";

/**
 * Escape XML special characters for TwiML.
 */
function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Map voice name to Polly voice for TwiML.
 */
function mapVoiceToPolly(voice?: string): string {
  const voiceMap: Record<string, string> = {
    alloy: "Polly.Joanna",
    echo: "Polly.Matthew",
    fable: "Polly.Salli",
    onyx: "Polly.Justin",
    nova: "Polly.Kendra",
    shimmer: "Polly.Kimberly",
  };
  return voice ? voiceMap[voice] || "Polly.Joanna" : "Polly.Joanna";
}

export interface TwilioVoiceProviderOptions {
  skipVerification?: boolean;
  publicUrl?: string;
  streamPath?: string;
}

/**
 * Twilio Voice API provider implementation.
 */
export class TwilioVoiceProvider implements VoiceCallProvider {
  readonly name = "twilio" as const;

  private readonly accountSid: string;
  private readonly authToken: string;
  private readonly baseUrl: string;
  private readonly options: TwilioVoiceProviderOptions;
  private currentPublicUrl: string | null = null;
  private callWebhookUrls = new Map<string, string>();
  private twimlStorage = new Map<string, string>();
  private notifyCalls = new Set<string>();
  private streamAuthTokens = new Map<string, string>();

  constructor(config: TwilioProviderConfig, options: TwilioVoiceProviderOptions = {}) {
    if (!config.accountSid) {
      throw new Error("Twilio Account SID is required");
    }
    if (!config.authToken) {
      throw new Error("Twilio Auth Token is required");
    }

    this.accountSid = config.accountSid;
    this.authToken = config.authToken;
    this.baseUrl = `https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}`;
    this.options = options;

    if (options.publicUrl) {
      this.currentPublicUrl = options.publicUrl;
    }
  }

  setPublicUrl(url: string): void {
    this.currentPublicUrl = url;
  }

  getPublicUrl(): string | null {
    return this.currentPublicUrl;
  }

  /**
   * Verify Twilio webhook signature.
   */
  verifyWebhook(ctx: WebhookContext): WebhookVerificationResult {
    if (this.options.skipVerification) {
      return { ok: true };
    }

    const signature = ctx.headers["x-twilio-signature"];
    if (!signature || typeof signature !== "string") {
      return { ok: false, reason: "Missing X-Twilio-Signature header" };
    }

    // Reconstruct URL for signature verification
    const url = this.currentPublicUrl
      ? `${this.currentPublicUrl}${new URL(ctx.url).pathname}${new URL(ctx.url).search}`
      : ctx.url;

    // Parse form data
    const params = new URLSearchParams(ctx.rawBody);
    const sortedParams = Array.from(params.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}${value}`)
      .join("");

    const data = url + sortedParams;
    const expectedSignature = crypto
      .createHmac("sha1", this.authToken)
      .update(data)
      .digest("base64");

    const isValid = crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature));

    if (!isValid) {
      return { ok: false, reason: "Invalid signature" };
    }

    return { ok: true };
  }

  /**
   * Parse Twilio webhook event into normalized format.
   */
  parseWebhookEvent(ctx: WebhookContext): ProviderWebhookParseResult {
    try {
      const params = new URLSearchParams(ctx.rawBody);
      const callIdFromQuery =
        typeof ctx.query?.callId === "string" ? ctx.query.callId.trim() : undefined;

      const event = this.normalizeEvent(params, callIdFromQuery);
      const twiml = this.generateTwimlResponse(ctx);

      return {
        events: event ? [event] : [],
        providerResponseBody: twiml,
        providerResponseHeaders: { "Content-Type": "application/xml" },
        statusCode: 200,
      };
    } catch {
      return { events: [], statusCode: 400 };
    }
  }

  private normalizeEvent(params: URLSearchParams, callIdOverride?: string): NormalizedEvent | null {
    const callSid = params.get("CallSid") || "";
    const direction = params.get("Direction");

    const baseEvent = {
      id: crypto.randomUUID(),
      callId: callIdOverride || callSid,
      providerCallId: callSid,
      timestamp: Date.now(),
      direction: this.parseDirection(direction),
      from: params.get("From") || undefined,
      to: params.get("To") || undefined,
    };

    // Handle speech result
    const speechResult = params.get("SpeechResult");
    if (speechResult) {
      return {
        ...baseEvent,
        type: "call.speech",
        transcript: speechResult,
        isFinal: true,
        confidence: parseFloat(params.get("Confidence") || "0.9"),
      };
    }

    // Handle DTMF
    const digits = params.get("Digits");
    if (digits) {
      return { ...baseEvent, type: "call.dtmf", digits };
    }

    // Handle call status changes
    const callStatus = params.get("CallStatus");
    switch (callStatus) {
      case "initiated":
        return { ...baseEvent, type: "call.initiated" };
      case "ringing":
        return { ...baseEvent, type: "call.ringing" };
      case "in-progress":
        return { ...baseEvent, type: "call.answered" };
      case "completed":
      case "busy":
      case "no-answer":
      case "failed":
        this.cleanupCall(callSid, callIdOverride);
        return { ...baseEvent, type: "call.ended", reason: callStatus };
      case "canceled":
        this.cleanupCall(callSid, callIdOverride);
        return { ...baseEvent, type: "call.ended", reason: "hangup-bot" };
      default:
        return null;
    }
  }

  private parseDirection(direction: string | null): "inbound" | "outbound" | undefined {
    if (direction === "inbound") return "inbound";
    if (direction === "outbound-api" || direction === "outbound-dial") return "outbound";
    return undefined;
  }

  private cleanupCall(callSid: string, callId?: string): void {
    this.streamAuthTokens.delete(callSid);
    if (callId) {
      this.twimlStorage.delete(callId);
      this.notifyCalls.delete(callId);
    }
  }

  private generateTwimlResponse(ctx?: WebhookContext): string {
    if (!ctx) {
      return '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
    }

    const params = new URLSearchParams(ctx.rawBody);
    const type = typeof ctx.query?.type === "string" ? ctx.query.type.trim() : undefined;
    const isStatusCallback = type === "status";
    const callStatus = params.get("CallStatus");
    const direction = params.get("Direction");
    const isOutbound = direction?.startsWith("outbound") ?? false;
    const callSid = params.get("CallSid") || undefined;
    const callIdFromQuery =
      typeof ctx.query?.callId === "string" ? ctx.query.callId.trim() : undefined;

    // Check for stored TwiML (notify mode)
    if (callIdFromQuery && !isStatusCallback) {
      const storedTwiml = this.twimlStorage.get(callIdFromQuery);
      if (storedTwiml) {
        this.twimlStorage.delete(callIdFromQuery);
        return storedTwiml;
      }
      if (this.notifyCalls.has(callIdFromQuery)) {
        return '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
      }

      // Conversation mode: return streaming TwiML for outbound calls
      if (isOutbound && callSid) {
        const streamUrl = this.getStreamUrlForCall(callSid);
        if (streamUrl) {
          return this.getStreamConnectXml(streamUrl);
        }
      }
    }

    if (isStatusCallback) {
      return '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
    }

    // For inbound calls, answer immediately with stream
    if (direction === "inbound" && callSid) {
      const streamUrl = this.getStreamUrlForCall(callSid);
      if (streamUrl) {
        return this.getStreamConnectXml(streamUrl);
      }
    }

    if (callStatus !== "in-progress") {
      return '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
    }

    const streamUrl = callSid ? this.getStreamUrlForCall(callSid) : null;
    if (streamUrl) {
      return this.getStreamConnectXml(streamUrl);
    }

    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Pause length="30"/>
</Response>`;
  }

  private getStreamUrl(): string | null {
    if (!this.currentPublicUrl || !this.options.streamPath) {
      return null;
    }

    const url = new URL(this.currentPublicUrl);
    const wsOrigin = url.origin.replace(/^https:\/\//, "wss://").replace(/^http:\/\//, "ws://");
    const path = this.options.streamPath.startsWith("/")
      ? this.options.streamPath
      : `/${this.options.streamPath}`;

    return `${wsOrigin}${path}`;
  }

  private getStreamAuthToken(callSid: string): string {
    const existing = this.streamAuthTokens.get(callSid);
    if (existing) return existing;
    const token = crypto.randomBytes(16).toString("base64url");
    this.streamAuthTokens.set(callSid, token);
    return token;
  }

  private getStreamUrlForCall(callSid: string): string | null {
    const baseUrl = this.getStreamUrl();
    if (!baseUrl) return null;
    const token = this.getStreamAuthToken(callSid);
    const url = new URL(baseUrl);
    url.searchParams.set("token", token);
    return url.toString();
  }

  private getStreamConnectXml(streamUrl: string): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${escapeXml(streamUrl)}" />
  </Connect>
</Response>`;
  }

  /**
   * Make an authenticated request to the Twilio API.
   */
  private async apiRequest<T = Record<string, unknown>>(
    endpoint: string,
    params: Record<string, string | string[]>,
    options?: { allowNotFound?: boolean },
  ): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;
    const auth = Buffer.from(`${this.accountSid}:${this.authToken}`).toString("base64");

    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (Array.isArray(value)) {
        for (const v of value) {
          body.append(key, v);
        }
      } else {
        body.append(key, value);
      }
    }

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });

    if (!response.ok) {
      if (options?.allowNotFound && response.status === 404) {
        return {} as T;
      }
      const error = await response.text();
      throw new Error(`Twilio API error: ${response.status} ${error}`);
    }

    return response.json() as Promise<T>;
  }

  async initiateCall(input: InitiateCallInput): Promise<InitiateCallResult> {
    const url = new URL(input.webhookUrl);
    url.searchParams.set("callId", input.callId);

    const statusUrl = new URL(input.webhookUrl);
    statusUrl.searchParams.set("callId", input.callId);
    statusUrl.searchParams.set("type", "status");

    if (input.inlineTwiml) {
      this.twimlStorage.set(input.callId, input.inlineTwiml);
      this.notifyCalls.add(input.callId);
    }

    const params: Record<string, string | string[]> = {
      To: input.to,
      From: input.from,
      Url: url.toString(),
      StatusCallback: statusUrl.toString(),
      StatusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
      Timeout: "30",
    };

    const result = await this.apiRequest<{ sid: string; status: string }>("/Calls.json", params);

    this.callWebhookUrls.set(result.sid, url.toString());

    return {
      providerCallId: result.sid,
      status: result.status === "queued" ? "queued" : "initiated",
    };
  }

  async hangupCall(input: HangupCallInput): Promise<void> {
    this.cleanupCall(input.providerCallId, input.callId);
    this.callWebhookUrls.delete(input.providerCallId);

    await this.apiRequest(
      `/Calls/${input.providerCallId}.json`,
      { Status: "completed" },
      { allowNotFound: true },
    );
  }

  async playTts(input: PlayTtsInput): Promise<void> {
    const webhookUrl = this.callWebhookUrls.get(input.providerCallId);
    if (!webhookUrl) {
      throw new Error("Missing webhook URL for this call");
    }

    const pollyVoice = mapVoiceToPolly(input.voice);
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="${pollyVoice}" language="${input.locale || "en-US"}">${escapeXml(input.text)}</Say>
  <Gather input="speech" speechTimeout="auto" action="${escapeXml(webhookUrl)}" method="POST">
    <Say>.</Say>
  </Gather>
</Response>`;

    await this.apiRequest(`/Calls/${input.providerCallId}.json`, {
      Twiml: twiml,
    });
  }

  async startListening(input: StartListeningInput): Promise<void> {
    const webhookUrl = this.callWebhookUrls.get(input.providerCallId);
    if (!webhookUrl) {
      throw new Error("Missing webhook URL for this call");
    }

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" speechTimeout="auto" language="${input.language || "en-US"}" action="${escapeXml(webhookUrl)}" method="POST">
  </Gather>
</Response>`;

    await this.apiRequest(`/Calls/${input.providerCallId}.json`, {
      Twiml: twiml,
    });
  }

  async stopListening(_input: StopListeningInput): Promise<void> {
    // Twilio's <Gather> automatically stops on speech end
  }

  /**
   * Generate TwiML for notify mode.
   */
  generateNotifyTwiml(message: string, voice?: string): string {
    const pollyVoice = mapVoiceToPolly(voice);
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="${pollyVoice}">${escapeXml(message)}</Say>
  <Hangup/>
</Response>`;
  }
}
