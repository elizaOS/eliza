import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { VoiceCallSettings } from "./environment";
import type {
  CallId,
  CallRecord,
  CallState,
  NormalizedEvent,
  OutboundCallOptions,
  TranscriptEntry,
} from "./types";

/**
 * CallManager handles call lifecycle, state machine, persistence, and history.
 */
export class CallManager {
  private activeCalls = new Map<CallId, CallRecord>();
  private callHistory: CallRecord[] = [];
  private providerCallIdMap = new Map<string, CallId>();
  private processedEventIds = new Set<string>();
  private settings: VoiceCallSettings;
  private webhookUrl: string | null = null;
  private storePath: string | null = null;
  private transcriptWaiters = new Map<
    CallId,
    {
      resolve: (text: string) => void;
      reject: (err: Error) => void;
      timeout: NodeJS.Timeout;
    }
  >();
  private maxDurationTimers = new Map<CallId, NodeJS.Timeout>();

  constructor(settings: VoiceCallSettings) {
    this.settings = settings;
  }

  /**
   * Initialize the call manager with a webhook URL and optional store path.
   */
  initialize(webhookUrl: string, storePath?: string): void {
    this.webhookUrl = webhookUrl;
    if (storePath) {
      this.storePath = storePath;
      this.loadCallHistory();
    }
  }

  /**
   * Get the webhook URL.
   */
  getWebhookUrl(): string | null {
    return this.webhookUrl;
  }

  /**
   * Create a new call record for an outbound call.
   */
  createOutboundCall(
    to: string,
    options?: OutboundCallOptions,
  ): { callId: CallId; record: CallRecord } {
    const callId = crypto.randomUUID();
    const mode = options?.mode ?? this.settings.outbound.defaultMode;

    const callRecord: CallRecord = {
      callId,
      provider: this.settings.provider,
      direction: "outbound",
      state: "initiated",
      from: this.settings.fromNumber,
      to,
      startedAt: Date.now(),
      transcript: [],
      processedEventIds: [],
      metadata: {
        ...(options?.message && { initialMessage: options.message }),
        mode,
      },
    };

    this.activeCalls.set(callId, callRecord);
    return { callId, record: callRecord };
  }

  /**
   * Create a new call record for an inbound call.
   */
  createInboundCall(providerCallId: string, from: string, to: string): CallRecord {
    const callId = crypto.randomUUID();

    const callRecord: CallRecord = {
      callId,
      providerCallId,
      provider: this.settings.provider,
      direction: "inbound",
      state: "ringing",
      from,
      to,
      startedAt: Date.now(),
      transcript: [],
      processedEventIds: [],
      metadata: {
        initialMessage: this.settings.inboundGreeting || "Hello! How can I help you today?",
      },
    };

    this.activeCalls.set(callId, callRecord);
    this.providerCallIdMap.set(providerCallId, callId);

    return callRecord;
  }

  /**
   * Update a call's provider call ID.
   */
  updateProviderCallId(callId: CallId, providerCallId: string): void {
    const call = this.activeCalls.get(callId);
    if (call) {
      if (call.providerCallId) {
        this.providerCallIdMap.delete(call.providerCallId);
      }
      call.providerCallId = providerCallId;
      this.providerCallIdMap.set(providerCallId, callId);
    }
  }

  /**
   * Get a call by internal ID.
   */
  getCall(callId: CallId): CallRecord | undefined {
    return this.activeCalls.get(callId);
  }

  /**
   * Get a call by provider call ID.
   */
  getCallByProviderCallId(providerCallId: string): CallRecord | undefined {
    const callId = this.providerCallIdMap.get(providerCallId);
    if (callId) {
      return this.activeCalls.get(callId);
    }
    // Fallback: linear search
    for (const call of this.activeCalls.values()) {
      if (call.providerCallId === providerCallId) {
        return call;
      }
    }
    return undefined;
  }

  /**
   * Get all active calls.
   */
  getActiveCalls(): CallRecord[] {
    return Array.from(this.activeCalls.values());
  }

  /**
   * Check if at max concurrent calls.
   */
  isAtMaxConcurrentCalls(): boolean {
    return this.activeCalls.size >= this.settings.maxConcurrentCalls;
  }

  /**
   * Update call state.
   */
  updateState(callId: CallId, newState: CallState): void {
    const call = this.activeCalls.get(callId);
    if (!call) return;

    this.transitionState(call, newState);
  }

  /**
   * Add a transcript entry.
   */
  addTranscriptEntry(callId: CallId, speaker: "bot" | "user", text: string): void {
    const call = this.activeCalls.get(callId);
    if (!call) return;

    const entry: TranscriptEntry = {
      timestamp: Date.now(),
      speaker,
      text,
      isFinal: true,
    };
    call.transcript.push(entry);
  }

  /**
   * Mark call as answered.
   */
  markAnswered(callId: CallId): void {
    const call = this.activeCalls.get(callId);
    if (call) {
      call.answeredAt = Date.now();
      this.transitionState(call, "answered");
      this.startMaxDurationTimer(callId);
    }
  }

  /**
   * Mark call as ended.
   */
  markEnded(callId: CallId, reason: CallState): void {
    const call = this.activeCalls.get(callId);
    if (!call) return;

    call.endedAt = Date.now();
    call.endReason = reason as CallRecord["endReason"];
    this.transitionState(call, reason);
    this.clearMaxDurationTimer(callId);
    this.rejectTranscriptWaiter(callId, `Call ended: ${reason}`);

    // Persist to history and JSONL store
    this.callHistory.push({ ...call });
    this.persistCall(call);

    this.activeCalls.delete(callId);
    if (call.providerCallId) {
      this.providerCallIdMap.delete(call.providerCallId);
    }
  }

  /**
   * Process a webhook event.
   */
  processEvent(event: NormalizedEvent): CallRecord | undefined {
    if (this.processedEventIds.has(event.id)) {
      return undefined;
    }
    this.processedEventIds.add(event.id);

    let call = this.findCall(event.callId);

    // Handle inbound calls
    if (!call && event.direction === "inbound" && event.providerCallId) {
      if (!this.shouldAcceptInbound(event.from)) {
        return undefined;
      }
      call = this.createInboundCall(
        event.providerCallId,
        event.from || "unknown",
        event.to || this.settings.fromNumber,
      );
    }

    if (!call) return undefined;

    // Update provider call ID
    if (event.providerCallId && event.providerCallId !== call.providerCallId) {
      this.updateProviderCallId(call.callId, event.providerCallId);
    }

    call.processedEventIds.push(event.id);

    // Process based on event type
    switch (event.type) {
      case "call.initiated":
        this.transitionState(call, "initiated");
        break;
      case "call.ringing":
        this.transitionState(call, "ringing");
        break;
      case "call.answered":
        call.answeredAt = event.timestamp;
        this.transitionState(call, "answered");
        this.startMaxDurationTimer(call.callId);
        break;
      case "call.active":
        this.transitionState(call, "active");
        break;
      case "call.speaking":
        this.transitionState(call, "speaking");
        break;
      case "call.speech":
        if (event.isFinal) {
          this.addTranscriptEntry(call.callId, "user", event.transcript);
          this.resolveTranscriptWaiter(call.callId, event.transcript);
        }
        this.transitionState(call, "listening");
        break;
      case "call.ended":
        this.markEnded(call.callId, event.reason as CallState);
        break;
      case "call.error":
        if (!event.retryable) {
          this.markEnded(call.callId, "error");
        }
        break;
    }

    return call;
  }

  /**
   * Wait for a final transcript.
   */
  waitForFinalTranscript(callId: CallId): Promise<string> {
    this.rejectTranscriptWaiter(callId, "Transcript waiter replaced");

    const timeoutMs = this.settings.transcriptTimeoutMs;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.transcriptWaiters.delete(callId);
        reject(new Error(`Timed out waiting for transcript after ${timeoutMs}ms`));
      }, timeoutMs);

      this.transcriptWaiters.set(callId, { resolve, reject, timeout });
    });
  }

  /**
   * Get call history (completed calls).
   * @param limit - Maximum number of entries to return (most recent first).
   */
  getCallHistory(limit = 50): CallRecord[] {
    return this.callHistory.slice(-limit).reverse();
  }

  // ----- Persistence (JSONL) -----

  /**
   * Persist a completed call record to the JSONL store.
   */
  private persistCall(call: CallRecord): void {
    if (!this.storePath) return;

    try {
      const dir = path.dirname(this.storePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const line = JSON.stringify(call) + "\n";
      fs.appendFileSync(this.storePath, line, "utf-8");
    } catch {
      // Best-effort persistence; don't crash the service
    }
  }

  /**
   * Load call history from the JSONL store on startup.
   * Used for crash recovery and history queries.
   */
  private loadCallHistory(): void {
    if (!this.storePath || !fs.existsSync(this.storePath)) return;

    try {
      const data = fs.readFileSync(this.storePath, "utf-8");
      const lines = data.split("\n").filter((l) => l.trim());

      for (const line of lines) {
        try {
          const parsed = JSON.parse(line) as CallRecord;
          this.callHistory.push(parsed);
        } catch {
          // Skip malformed lines
        }
      }
    } catch {
      // Best-effort loading; don't crash the service
    }
  }

  // Private helpers

  private findCall(callIdOrProviderCallId: string): CallRecord | undefined {
    const directCall = this.activeCalls.get(callIdOrProviderCallId);
    if (directCall) return directCall;
    return this.getCallByProviderCallId(callIdOrProviderCallId);
  }

  private shouldAcceptInbound(from: string | undefined): boolean {
    const { inboundPolicy, allowFrom } = this.settings;

    switch (inboundPolicy) {
      case "disabled":
        return false;
      case "open":
        return true;
      case "allowlist":
      case "pairing":
        if (!from) return false;
        return allowFrom.some((allowed) => from.endsWith(allowed) || allowed.endsWith(from));
      default:
        return false;
    }
  }

  private static readonly ConversationStates = new Set<CallState>(["speaking", "listening"]);
  private static readonly StateOrder: readonly CallState[] = [
    "initiated",
    "ringing",
    "answered",
    "active",
    "speaking",
    "listening",
  ];
  private static readonly TerminalStates = new Set<CallState>([
    "completed",
    "hangup-user",
    "hangup-bot",
    "timeout",
    "error",
    "failed",
    "no-answer",
    "busy",
    "voicemail",
  ]);

  private transitionState(call: CallRecord, newState: CallState): void {
    if (call.state === newState || CallManager.TerminalStates.has(call.state)) {
      return;
    }

    if (CallManager.TerminalStates.has(newState)) {
      call.state = newState;
      return;
    }

    if (
      CallManager.ConversationStates.has(call.state) &&
      CallManager.ConversationStates.has(newState)
    ) {
      call.state = newState;
      return;
    }

    const currentIndex = CallManager.StateOrder.indexOf(call.state);
    const newIndex = CallManager.StateOrder.indexOf(newState);

    if (newIndex > currentIndex) {
      call.state = newState;
    }
  }

  private startMaxDurationTimer(callId: CallId): void {
    this.clearMaxDurationTimer(callId);

    const maxDurationMs = this.settings.maxDurationSeconds * 1000;
    const timer = setTimeout(() => {
      this.maxDurationTimers.delete(callId);
      const call = this.getCall(callId);
      if (call && !CallManager.TerminalStates.has(call.state)) {
        call.endReason = "timeout";
        this.markEnded(callId, "timeout");
      }
    }, maxDurationMs);

    this.maxDurationTimers.set(callId, timer);
  }

  private clearMaxDurationTimer(callId: CallId): void {
    const timer = this.maxDurationTimers.get(callId);
    if (timer) {
      clearTimeout(timer);
      this.maxDurationTimers.delete(callId);
    }
  }

  private clearTranscriptWaiter(callId: CallId): void {
    const waiter = this.transcriptWaiters.get(callId);
    if (waiter) {
      clearTimeout(waiter.timeout);
      this.transcriptWaiters.delete(callId);
    }
  }

  private rejectTranscriptWaiter(callId: CallId, reason: string): void {
    const waiter = this.transcriptWaiters.get(callId);
    if (waiter) {
      this.clearTranscriptWaiter(callId);
      waiter.reject(new Error(reason));
    }
  }

  private resolveTranscriptWaiter(callId: CallId, transcript: string): void {
    const waiter = this.transcriptWaiters.get(callId);
    if (waiter) {
      this.clearTranscriptWaiter(callId);
      waiter.resolve(transcript);
    }
  }
}
