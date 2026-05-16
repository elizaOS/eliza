import type {
  CloudSetupSessionService,
  FinalizeHandoffInput,
  SendMessageInput,
  SendMessageResult,
  StartSessionInput,
} from "./service-interface.js";
import type {
  ContainerHandoffEnvelope,
  SetupExtractedFact,
  SetupSessionEnvelope,
  SetupSessionId,
  SetupTranscriptMessage,
} from "./types.js";

interface MockSessionState {
  envelope: SetupSessionEnvelope;
  transcript: SetupTranscriptMessage[];
  facts: SetupExtractedFact[];
  turnCount: number;
  cancelled: boolean;
}

export interface MockCloudSetupSessionServiceOptions {
  now?: () => number;
  randomId?: () => string;
  /** Number of `getStatus` polls before the container flips from provisioning to ready. */
  provisioningTurns?: number;
}

const TOUR_SCRIPT: readonly string[] = [
  "Welcome — I'm your setup agent. What should I call you?",
  "Nice to meet you. What language do you want me to use day-to-day?",
  "Got it. I'll show you around while your container provisions in the background.",
  "First stop: settings. You can change your runtime, voice, and permissions here.",
  "Subscriptions next — that's where paid plugins live.",
  "Connectors let me reach things like iMessage, Slack, and your calendar.",
  "All set. As soon as your container is ready I'll move this conversation into it.",
];

export class MockCloudSetupSessionService implements CloudSetupSessionService {
  private readonly sessions = new Map<SetupSessionId, MockSessionState>();
  private readonly statusPolls = new Map<SetupSessionId, number>();
  private readonly now: () => number;
  private readonly randomId: () => string;
  private readonly provisioningTurns: number;

  constructor(options: MockCloudSetupSessionServiceOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.randomId =
      options.randomId ??
      (() => `mock_${Math.random().toString(36).slice(2, 10)}`);
    this.provisioningTurns = options.provisioningTurns ?? 1;
  }

  async startSession(
    input: StartSessionInput,
  ): Promise<SetupSessionEnvelope> {
    const sessionId = this.randomId();
    const containerId = this.randomId();
    const envelope: SetupSessionEnvelope = {
      sessionId,
      tenantId: input.tenantId,
      createdAt: this.now(),
      containerStatus: "provisioning",
      containerId,
    };
    const greeting: SetupTranscriptMessage = {
      id: this.randomId(),
      role: "agent",
      content: TOUR_SCRIPT[0] ?? "Hello.",
      createdAt: this.now(),
    };
    this.sessions.set(sessionId, {
      envelope,
      transcript: [greeting],
      facts: [],
      turnCount: 0,
      cancelled: false,
    });
    this.statusPolls.set(sessionId, 0);
    return { ...envelope };
  }

  async sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
    const state = this.requireSession(input.sessionId);
    if (state.cancelled) {
      throw new Error("setup session cancelled");
    }
    const userMessage: SetupTranscriptMessage = {
      id: this.randomId(),
      role: "user",
      content: input.message,
      createdAt: this.now(),
    };
    state.transcript.push(userMessage);
    state.turnCount += 1;

    const scriptIndex = Math.min(state.turnCount, TOUR_SCRIPT.length - 1);
    const reply: SetupTranscriptMessage = {
      id: this.randomId(),
      role: "agent",
      content: TOUR_SCRIPT[scriptIndex] ?? "",
      createdAt: this.now(),
    };
    state.transcript.push(reply);

    const facts: SetupExtractedFact[] = [];
    if (state.turnCount === 1) {
      facts.push({
        key: "owner.name",
        value: input.message,
        confidence: 0.6,
        source: "user",
      });
    } else if (state.turnCount === 2) {
      facts.push({
        key: "owner.language",
        value: input.message,
        confidence: 0.7,
        source: "user",
      });
    }
    state.facts.push(...facts);

    return { replies: [reply], facts };
  }

  async getStatus(sessionId: SetupSessionId): Promise<SetupSessionEnvelope> {
    const state = this.requireSession(sessionId);
    const polls = (this.statusPolls.get(sessionId) ?? 0) + 1;
    this.statusPolls.set(sessionId, polls);
    if (
      state.envelope.containerStatus === "provisioning" &&
      polls >= this.provisioningTurns
    ) {
      state.envelope = { ...state.envelope, containerStatus: "ready" };
    }
    return { ...state.envelope };
  }

  async finalizeHandoff(
    input: FinalizeHandoffInput,
  ): Promise<ContainerHandoffEnvelope> {
    const state = this.requireSession(input.sessionId);
    if (state.envelope.containerStatus !== "ready") {
      throw new Error(
        `cannot finalize handoff: container status is ${state.envelope.containerStatus}`,
      );
    }
    const memoryIds = state.transcript.map((m) => m.id);
    return {
      sessionId: state.envelope.sessionId,
      tenantId: state.envelope.tenantId,
      containerId: input.containerId,
      transcript: [...state.transcript],
      facts: [...state.facts],
      memoryIds,
    };
  }

  async cancel(sessionId: SetupSessionId): Promise<void> {
    const state = this.requireSession(sessionId);
    state.cancelled = true;
    this.sessions.delete(sessionId);
    this.statusPolls.delete(sessionId);
  }

  private requireSession(sessionId: SetupSessionId): MockSessionState {
    const state = this.sessions.get(sessionId);
    if (!state) {
      throw new Error(`unknown setup session: ${sessionId}`);
    }
    return state;
  }
}
