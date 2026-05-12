import type { IAgentRuntime } from "@elizaos/core";
import { logger, Service } from "@elizaos/core";
import {
  AstrologyEngine,
  type AstrologyReadingState as AstrologyEngineState,
} from "../engines/astrology/index";
import { IChingEngine } from "../engines/iching/index";
import { TarotEngine } from "../engines/tarot/index";

import type {
  BirthData,
  CrisisIndicators,
  FeedbackEntry,
  IChingReadingState,
  PaymentRecord,
  ReadingSession,
  ReadingSystem,
  TarotReadingState,
} from "../types";

interface RevealResult {
  prompt: string;
  element: string;
}

interface PricingConfig {
  tarot: string;
  iching: string;
  astrology: string;
}

const CRISIS_KEYWORDS_HIGH: readonly string[] = [
  "suicide",
  "kill myself",
  "end my life",
  "end it all",
  "want to die",
  "no reason to live",
  "better off dead",
  "planning to die",
  "going to kill",
  "take my own life",
  "slit my wrists",
  "overdose",
  "jump off",
  "hang myself",
];

const CRISIS_KEYWORDS_MEDIUM: readonly string[] = [
  "self-harm",
  "self harm",
  "hurt myself",
  "cutting myself",
  "don't want to be here",
  "can't go on",
  "no point in living",
  "wish i was dead",
  "wish i were dead",
  "nothing to live for",
  "life isn't worth",
  "hopeless",
];

const CRISIS_KEYWORDS_LOW: readonly string[] = [
  "depressed",
  "so alone",
  "nobody cares",
  "worthless",
  "give up",
  "can't take it",
  "falling apart",
  "breaking down",
  "desperate",
];

const CRISIS_RESOURCES =
  "If you or someone you know is in crisis, please reach out for help:\n" +
  "• **National Suicide Prevention Lifeline:** 988 (call or text)\n" +
  "• **Crisis Text Line:** Text HOME to 741741\n" +
  "• **International Association for Suicide Prevention:** https://www.iasp.info/resources/Crisis_Centres/\n" +
  "\nYou are not alone, and there are people who care about you.";

const DEFAULT_PRICING: PricingConfig = {
  tarot: "0.01",
  iching: "0.01",
  astrology: "0.02",
};

function sessionKey(entityId: string, roomId: string): string {
  return `${entityId}:${roomId}`;
}

export class MysticismService extends Service {
  static serviceType = "MYSTICISM";
  capabilityDescription = "Manages mystical reading sessions for tarot, I Ching, and astrology";

  private tarotEngine: TarotEngine;
  private ichingEngine: IChingEngine;
  private astrologyEngine: AstrologyEngine;
  private sessions: Map<string, ReadingSession>;
  private tarotStates: Map<string, TarotReadingState>;
  private ichingStates: Map<string, IChingReadingState>;
  private astrologyStates: Map<string, AstrologyEngineState>;
  private paymentHistory: Map<string, PaymentRecord[]>;
  private pricing: PricingConfig;

  constructor(runtime?: IAgentRuntime) {
    super(runtime);

    this.tarotEngine = new TarotEngine();
    this.ichingEngine = new IChingEngine();
    this.astrologyEngine = new AstrologyEngine();

    this.sessions = new Map();
    this.tarotStates = new Map();
    this.ichingStates = new Map();
    this.astrologyStates = new Map();
    this.paymentHistory = new Map();
    this.pricing = { ...DEFAULT_PRICING };
  }

  static async start(runtime: IAgentRuntime): Promise<MysticismService> {
    const service = new MysticismService(runtime);

    const tarotPrice = runtime.getSetting("MYSTICISM_PRICE_TAROT");
    const ichingPrice = runtime.getSetting("MYSTICISM_PRICE_ICHING");
    const astrologyPrice = runtime.getSetting("MYSTICISM_PRICE_ASTROLOGY");

    if (tarotPrice) service.pricing.tarot = String(tarotPrice);
    if (ichingPrice) service.pricing.iching = String(ichingPrice);
    if (astrologyPrice) service.pricing.astrology = String(astrologyPrice);

    logger.info(
      {
        pricing: service.pricing,
      },
      "MysticismService started"
    );

    return service;
  }

  async stop(): Promise<void> {
    const sessionCount = this.sessions.size;
    this.sessions.clear();
    this.tarotStates.clear();
    this.ichingStates.clear();
    this.astrologyStates.clear();
    this.paymentHistory.clear();

    logger.info({ clearedSessions: sessionCount }, "MysticismService stopped");
  }

  startTarotReading(
    entityId: string,
    roomId: string,
    spreadId: string,
    question: string
  ): ReadingSession {
    const key = sessionKey(entityId, roomId);

    if (this.sessions.has(key)) {
      this.endSession(entityId, roomId);
    }

    const tarotState = this.tarotEngine.startReading(spreadId, question);
    this.tarotStates.set(key, tarotState);

    const session = this.createSession(entityId, roomId, "tarot");
    session.tarot = tarotState;
    this.sessions.set(key, session);

    logger.info(
      {
        entityId,
        roomId,
        spread: spreadId,
        cardCount: tarotState.drawnCards.length,
      },
      "Tarot reading started"
    );

    return session;
  }

  startIChingReading(entityId: string, roomId: string, question: string): ReadingSession {
    const key = sessionKey(entityId, roomId);

    if (this.sessions.has(key)) {
      this.endSession(entityId, roomId);
    }

    const ichingState = this.ichingEngine.startReading(question);
    this.ichingStates.set(key, ichingState);

    const session = this.createSession(entityId, roomId, "iching");
    session.iching = ichingState;
    this.sessions.set(key, session);

    logger.info(
      {
        entityId,
        roomId,
        hexagram: ichingState.hexagram.number,
        changingLines: ichingState.castResult.changingLines.length,
      },
      "I Ching reading started"
    );

    return session;
  }

  startAstrologyReading(entityId: string, roomId: string, birthData: BirthData): ReadingSession {
    const key = sessionKey(entityId, roomId);

    if (this.sessions.has(key)) {
      this.endSession(entityId, roomId);
    }

    const engineBirthData = {
      year: birthData.year,
      month: birthData.month,
      day: birthData.day ?? 1,
      hour: birthData.hour ?? 12,
      minute: birthData.minute ?? 0,
      latitude: birthData.latitude ?? 0,
      longitude: birthData.longitude ?? 0,
      timezone: birthData.timezone ?? 0,
    };
    const astroState = this.astrologyEngine.startReading(engineBirthData);
    this.astrologyStates.set(key, astroState);

    const session = this.createSession(entityId, roomId, "astrology");
    session.astrology = {
      birthData,
      chart: astroState.chart,
      revealedPlanets: [],
      revealedHouses: [],
      userFeedback: [],
    };
    this.sessions.set(key, session);

    logger.info(
      {
        entityId,
        roomId,
        sunSign: astroState.chart.sun.sign,
      },
      "Astrology reading started"
    );

    return session;
  }

  getSession(entityId: string, roomId: string): ReadingSession | null {
    return this.sessions.get(sessionKey(entityId, roomId)) ?? null;
  }

  getNextReveal(entityId: string, roomId: string): RevealResult | null {
    const key = sessionKey(entityId, roomId);
    const session = this.sessions.get(key);
    if (!session) return null;

    session.phase = "interpretation";
    session.updatedAt = Date.now();

    switch (session.type) {
      case "tarot":
        return this.getNextTarotReveal(key);
      case "iching":
        return this.getNextIChingReveal(key);
      case "astrology":
        return this.getNextAstrologyReveal(key);
      default:
        return null;
    }
  }

  /** Feedback is forwarded to the engine and also adjusts session rapport. */
  recordFeedback(entityId: string, roomId: string, feedback: FeedbackEntry): void {
    const key = sessionKey(entityId, roomId);
    const session = this.sessions.get(key);
    if (!session) {
      logger.warn(
        {
          entityId,
          roomId,
        },
        "Cannot record feedback: no active session"
      );
      return;
    }

    session.updatedAt = Date.now();

    switch (session.type) {
      case "tarot":
        this.recordTarotFeedback(key, feedback);
        break;
      case "iching":
        this.recordIChingFeedback(key, feedback);
        break;
      case "astrology":
        this.recordAstrologyFeedback(key, feedback);
        break;
    }
  }

  getSynthesis(entityId: string, roomId: string): string | null {
    const key = sessionKey(entityId, roomId);
    const session = this.sessions.get(key);
    if (!session) return null;

    session.phase = "synthesis";
    session.updatedAt = Date.now();

    try {
      switch (session.type) {
        case "tarot": {
          const tarotState = this.tarotStates.get(key);
          if (!tarotState) return null;
          return this.tarotEngine.getSynthesis(tarotState);
        }
        case "iching": {
          const ichingState = this.ichingStates.get(key);
          if (!ichingState) return null;
          return this.ichingEngine.getSynthesis(ichingState);
        }
        case "astrology": {
          const astroState = this.astrologyStates.get(key);
          if (!astroState) return null;
          return this.astrologyEngine.getSynthesis(astroState);
        }
        default:
          return null;
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Unknown synthesis error";
      logger.error(
        {
          entityId,
          roomId,
          error: errorMessage,
        },
        "Synthesis generation failed"
      );
      return null;
    }
  }

  /** Only available for tarot readings; returns null for other types. */
  getDeepeningPrompt(
    entityId: string,
    roomId: string,
    cardIndex: number,
    userResponse: string
  ): string | null {
    const key = sessionKey(entityId, roomId);
    const session = this.sessions.get(key);
    if (!session || session.type !== "tarot") return null;

    const tarotState = this.tarotStates.get(key);
    if (!tarotState) return null;

    try {
      return this.tarotEngine.getDeepening(tarotState, cardIndex, userResponse);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Unknown deepening error";
      logger.error(
        {
          entityId,
          roomId,
          cardIndex,
          error: errorMessage,
        },
        "Deepening prompt generation failed"
      );
      return null;
    }
  }

  getIChingCastingSummary(entityId: string, roomId: string): string | null {
    const key = sessionKey(entityId, roomId);
    const ichingState = this.ichingStates.get(key);
    if (!ichingState) return null;
    return this.ichingEngine.getCastingSummary(ichingState);
  }

  endSession(entityId: string, roomId: string): void {
    const key = sessionKey(entityId, roomId);

    const session = this.sessions.get(key);
    if (session) {
      session.phase = "closing";
      logger.info(
        {
          entityId,
          roomId,
          type: session.type,
        },
        "Reading session ended"
      );
    }

    this.sessions.delete(key);
    this.tarotStates.delete(key);
    this.ichingStates.delete(key);
    this.astrologyStates.delete(key);
  }

  recordPayment(payment: PaymentRecord): void {
    const existing = this.paymentHistory.get(payment.entityId) ?? [];
    existing.push(payment);
    this.paymentHistory.set(payment.entityId, existing);

    logger.info(
      {
        entityId: payment.entityId,
        amount: payment.amount,
        currency: payment.currency,
        system: payment.system,
      },
      "Payment recorded"
    );
  }

  getPaymentHistory(entityId: string): PaymentRecord[] {
    return this.paymentHistory.get(entityId) ?? [];
  }

  getPricing(): PricingConfig {
    return { ...this.pricing };
  }

  /**
   * When severity is HIGH, the reading should be stopped immediately
   * and crisis resources provided.
   */
  detectCrisis(text: string): CrisisIndicators {
    const normalizedText = text.toLowerCase();

    const highMatches = CRISIS_KEYWORDS_HIGH.filter((kw) => normalizedText.includes(kw));
    if (highMatches.length > 0) {
      return {
        detected: true,
        severity: "high",
        keywords: [...highMatches],
        recommendedAction:
          "STOP the reading immediately. Express genuine concern. " +
          "Provide crisis resources:\n\n" +
          CRISIS_RESOURCES,
      };
    }

    const mediumMatches = CRISIS_KEYWORDS_MEDIUM.filter((kw) => normalizedText.includes(kw));
    if (mediumMatches.length > 0) {
      return {
        detected: true,
        severity: "medium",
        keywords: [...mediumMatches],
        recommendedAction:
          "Gently acknowledge the querent's feelings. Offer crisis resources " +
          "without being alarmist. Continue the reading only if the querent " +
          "wishes.\n\n" +
          CRISIS_RESOURCES,
      };
    }

    const lowMatches = CRISIS_KEYWORDS_LOW.filter((kw) => normalizedText.includes(kw));
    if (lowMatches.length > 0) {
      return {
        detected: true,
        severity: "low",
        keywords: [...lowMatches],
        recommendedAction:
          "Be mindful and compassionate. Frame interpretations with " +
          "sensitivity. Consider mentioning that support is available " +
          "if the querent is struggling.",
      };
    }

    return {
      detected: false,
      severity: "low",
      keywords: [],
      recommendedAction: "",
    };
  }

  recordConversationPayment(
    entityId: string,
    roomId: string,
    amount: string,
    txHash: string
  ): void {
    const session = this.sessions.get(sessionKey(entityId, roomId));
    if (session) {
      session.paymentStatus = "paid";
      session.paymentAmount = amount;
      session.paymentTxHash = txHash;
      session.updatedAt = Date.now();
      logger.info({ entityId, roomId, amount, txHash }, "Payment recorded for conversation");
    }
  }

  markPaymentRequested(entityId: string, roomId: string, amount: string): void {
    const session = this.sessions.get(sessionKey(entityId, roomId));
    if (session) {
      session.paymentStatus = "requested";
      session.paymentAmount = amount;
      session.updatedAt = Date.now();
    }
  }

  private createSession(entityId: string, roomId: string, type: ReadingSystem): ReadingSession {
    return {
      id: crypto.randomUUID(),
      entityId,
      roomId,
      type,
      phase: "casting",
      paymentStatus: "none",
      paymentAmount: null,
      paymentTxHash: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      meta: {},
    };
  }

  private getNextTarotReveal(key: string): RevealResult | null {
    const tarotState = this.tarotStates.get(key);
    if (!tarotState) return null;

    const reveal = this.tarotEngine.getNextReveal(tarotState);
    if (!reveal) return null;

    const cardName = reveal.card.reversed
      ? `${reveal.card.card.name} (Reversed)`
      : reveal.card.card.name;

    return {
      prompt: reveal.prompt,
      element: `${reveal.position.name}: ${cardName}`,
    };
  }

  private getNextIChingReveal(key: string): RevealResult | null {
    const ichingState = this.ichingStates.get(key);
    if (!ichingState) return null;

    const reveal = this.ichingEngine.getNextReveal(ichingState);
    if (!reveal) return null;

    return {
      prompt: reveal.prompt,
      element: `Line ${reveal.linePosition}`,
    };
  }

  private getNextAstrologyReveal(key: string): RevealResult | null {
    const astroState = this.astrologyStates.get(key);
    if (!astroState) return null;

    const reveal = this.astrologyEngine.getNextReveal(astroState);
    if (!reveal) return null;

    // Sync projected state on the session
    const session = this.sessions.get(key);
    if (session?.astrology) {
      session.astrology.revealedPlanets = [...astroState.revealedPlanets];
    }

    return {
      prompt: reveal.prompt,
      element: reveal.planet,
    };
  }

  private recordTarotFeedback(key: string, feedback: FeedbackEntry): void {
    const tarotState = this.tarotStates.get(key);
    if (!tarotState) return;

    const newState = this.tarotEngine.recordFeedback(tarotState, feedback);
    this.tarotStates.set(key, newState);

    const session = this.sessions.get(key);
    if (session) {
      session.tarot = newState;
    }
  }

  private recordIChingFeedback(key: string, feedback: FeedbackEntry): void {
    const ichingState = this.ichingStates.get(key);
    if (!ichingState) return;

    const newState = this.ichingEngine.recordFeedback(ichingState, feedback);
    this.ichingStates.set(key, newState);

    const session = this.sessions.get(key);
    if (session) {
      session.iching = newState;
    }
  }

  /** Converts the types.ts FeedbackEntry to the astrology engine's format. */
  private recordAstrologyFeedback(key: string, feedback: FeedbackEntry): void {
    const astroState = this.astrologyStates.get(key);
    if (!astroState) return;

    const engineFeedback = {
      topic: feedback.element,
      response: feedback.userText,
      resonance: 3, // neutral default; the LLM interprets sentiment from text
      timestamp: feedback.timestamp,
    };

    const newState = this.astrologyEngine.recordFeedback(astroState, engineFeedback);
    this.astrologyStates.set(key, newState);

    const session = this.sessions.get(key);
    if (session?.astrology) {
      session.astrology.revealedPlanets = [...newState.revealedPlanets];
      session.astrology.userFeedback = [...session.astrology.userFeedback, feedback];
    }
  }
}
