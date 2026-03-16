/**
 * Mock voice call provider for development and testing.
 *
 * Does not make real network calls. Simulates call lifecycle
 * events for local dev workflows without Twilio credentials.
 */

import { logger } from "@elizaos/core";
import type {
  CallId,
  HangupCallInput,
  InitiateCallInput,
  InitiateCallResult,
  PlayTtsInput,
  ProviderWebhookParseResult,
  StartListeningInput,
  StopListeningInput,
  WebhookContext,
  WebhookVerificationResult,
} from "../types";
import type { VoiceCallProvider } from "./base";

/** Simulated call record for the mock provider. */
interface MockCall {
  callId: CallId;
  providerCallId: string;
  from: string;
  to: string;
  state: "initiated" | "ringing" | "active" | "ended";
  startedAt: number;
}

/**
 * Mock provider that logs actions instead of making real API calls.
 * Useful for development, testing, and demos without telephony credentials.
 */
export class MockProvider implements VoiceCallProvider {
  readonly name = "mock" as const;

  private calls: Map<string, MockCall> = new Map();
  private callCounter = 0;

  verifyWebhook(_ctx: WebhookContext): WebhookVerificationResult {
    // Mock always accepts webhooks
    return { ok: true };
  }

  parseWebhookEvent(_ctx: WebhookContext): ProviderWebhookParseResult {
    // Mock doesn't receive real webhooks
    return { events: [] };
  }

  async initiateCall(input: InitiateCallInput): Promise<InitiateCallResult> {
    this.callCounter++;
    const providerCallId = `mock-${Date.now()}-${this.callCounter}`;

    const mockCall: MockCall = {
      callId: input.callId,
      providerCallId,
      from: input.from,
      to: input.to,
      state: "initiated",
      startedAt: Date.now(),
    };

    this.calls.set(input.callId, mockCall);

    logger.info(
      `[mock] Initiated call ${input.callId}: ${input.from} -> ${input.to}`,
    );

    // Simulate ringing after a short delay
    setTimeout(() => {
      const call = this.calls.get(input.callId);
      if (call && call.state === "initiated") {
        call.state = "ringing";
        logger.info(`[mock] Call ${input.callId} is ringing`);
      }
    }, 500);

    // Simulate answer after ringing
    setTimeout(() => {
      const call = this.calls.get(input.callId);
      if (call && call.state === "ringing") {
        call.state = "active";
        logger.info(`[mock] Call ${input.callId} answered`);
      }
    }, 1500);

    return {
      providerCallId,
      status: "initiated",
    };
  }

  async hangupCall(input: HangupCallInput): Promise<void> {
    const call = this.calls.get(input.callId);
    if (call) {
      call.state = "ended";
      logger.info(
        `[mock] Hung up call ${input.callId} (reason: ${input.reason})`,
      );
    } else {
      logger.warn(`[mock] Hangup requested for unknown call ${input.callId}`);
    }
  }

  async playTts(input: PlayTtsInput): Promise<void> {
    logger.info(
      `[mock] TTS on call ${input.callId}: "${input.text}"${input.voice ? ` (voice: ${input.voice})` : ""}`,
    );
  }

  async startListening(input: StartListeningInput): Promise<void> {
    logger.info(
      `[mock] Started listening on call ${input.callId}${input.language ? ` (language: ${input.language})` : ""}`,
    );
  }

  async stopListening(input: StopListeningInput): Promise<void> {
    logger.info(`[mock] Stopped listening on call ${input.callId}`);
  }

  setPublicUrl(url: string): void {
    logger.info(`[mock] Public URL set to ${url}`);
  }
}
