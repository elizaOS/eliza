import type {
  HangupCallInput,
  InitiateCallInput,
  InitiateCallResult,
  PlayTtsInput,
  ProviderName,
  ProviderWebhookParseResult,
  StartListeningInput,
  StopListeningInput,
  WebhookContext,
  WebhookVerificationResult,
} from "../types";

/**
 * Abstract base interface for voice call providers.
 *
 * Each provider (Twilio, Mock) implements this interface
 * to provide a consistent API for the call manager.
 */
export interface VoiceCallProvider {
  /** Provider identifier */
  readonly name: ProviderName;

  /**
   * Verify webhook signature/HMAC before processing.
   */
  verifyWebhook(ctx: WebhookContext): WebhookVerificationResult;

  /**
   * Parse provider-specific webhook payload into normalized events.
   */
  parseWebhookEvent(ctx: WebhookContext): ProviderWebhookParseResult;

  /**
   * Initiate an outbound call.
   */
  initiateCall(input: InitiateCallInput): Promise<InitiateCallResult>;

  /**
   * Hang up an active call.
   */
  hangupCall(input: HangupCallInput): Promise<void>;

  /**
   * Play TTS audio to the caller.
   */
  playTts(input: PlayTtsInput): Promise<void>;

  /**
   * Start listening for user speech (activate STT).
   */
  startListening(input: StartListeningInput): Promise<void>;

  /**
   * Stop listening for user speech (deactivate STT).
   */
  stopListening(input: StopListeningInput): Promise<void>;

  /**
   * Set the public webhook URL (for providers that need it).
   */
  setPublicUrl?(url: string): void;
}
