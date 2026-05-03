import { beforeEach, describe, expect, it } from "vitest";
import { MysticismService } from "../../src/services/mysticism-service";
import type { BirthData, FeedbackEntry, PaymentRecord } from "../../src/types";

// ─── Test Fixtures ───────────────────────────

const ENTITY_A = "entity-aaa-111";
const ENTITY_B = "entity-bbb-222";
const ROOM_1 = "room-111";
const ROOM_2 = "room-222";

const TEST_BIRTH_DATA: BirthData = {
  year: 1990,
  month: 6,
  day: 15,
  hour: 12,
  minute: 0,
  latitude: 40.7,
  longitude: -74.0,
  timezone: -5,
};

function makeFeedback(element: string): FeedbackEntry {
  return {
    element,
    userText: "That resonates with me.",
    timestamp: Date.now(),
  };
}

function makePayment(
  entityId: string,
  system: "tarot" | "iching" | "astrology",
  amount = "0.01"
): PaymentRecord {
  return {
    id: crypto.randomUUID(),
    entityId,
    amount,
    currency: "SOL",
    system,
    timestamp: Date.now(),
    status: "completed",
  };
}

// ──────────────────────────────────────────────
// Session Management
// ──────────────────────────────────────────────

describe("Session Management", () => {
  let service: MysticismService;

  beforeEach(() => {
    service = new MysticismService();
  });

  it("startTarotReading creates session with correct type, phase, spread", () => {
    const session = service.startTarotReading(ENTITY_A, ROOM_1, "three_card", "What lies ahead?");

    expect(session.type).toBe("tarot");
    expect(session.phase).toBe("casting");
    expect(session.entityId).toBe(ENTITY_A);
    expect(session.roomId).toBe(ROOM_1);
    expect(session.tarot).toBeDefined();
    expect(session.tarot?.spread.id).toBe("three_card");
    expect(session.tarot?.drawnCards).toHaveLength(3);
    expect(session.tarot?.question).toBe("What lies ahead?");
    expect(session.id).toBeTypeOf("string");
    expect(session.id.length).toBeGreaterThan(0);
  });

  it("startIChingReading creates session with hexagram data", () => {
    const session = service.startIChingReading(ENTITY_A, ROOM_1, "What should I focus on?");

    expect(session.type).toBe("iching");
    expect(session.phase).toBe("casting");
    expect(session.iching).toBeDefined();
    expect(session.iching?.hexagram).toBeDefined();
    expect(session.iching?.hexagram.number).toBeGreaterThanOrEqual(1);
    expect(session.iching?.hexagram.number).toBeLessThanOrEqual(64);
    expect(session.iching?.castResult).toBeDefined();
    expect(session.iching?.castResult.lines).toHaveLength(6);
    expect(session.iching?.question).toBe("What should I focus on?");
  });

  it("startAstrologyReading creates session with natal chart data", () => {
    const session = service.startAstrologyReading(ENTITY_A, ROOM_1, TEST_BIRTH_DATA);

    expect(session.type).toBe("astrology");
    expect(session.phase).toBe("casting");
    expect(session.astrology).toBeDefined();
    expect(session.astrology?.birthData).toEqual(TEST_BIRTH_DATA);
    expect(session.astrology?.chart).toBeDefined();
    expect(session.astrology?.chart.sun).toBeDefined();
    expect(session.astrology?.chart.sun.sign).toBeTypeOf("string");
    expect(session.astrology?.chart.moon).toBeDefined();
    expect(session.astrology?.revealedPlanets).toEqual([]);
  });

  it("getSession returns null when no session exists", () => {
    const session = service.getSession(ENTITY_A, ROOM_1);
    expect(session).toBeNull();
  });

  it("getSession returns the session after starting a reading", () => {
    const started = service.startTarotReading(ENTITY_A, ROOM_1, "single", "Quick reading");
    const retrieved = service.getSession(ENTITY_A, ROOM_1);

    expect(retrieved).not.toBeNull();
    expect(retrieved?.id).toBe(started.id);
    expect(retrieved?.type).toBe("tarot");
  });

  it("starting a new reading replaces an existing session for same entity+room", () => {
    const first = service.startTarotReading(ENTITY_A, ROOM_1, "single", "First question");
    const second = service.startIChingReading(ENTITY_A, ROOM_1, "Second question");

    const session = service.getSession(ENTITY_A, ROOM_1);
    expect(session).not.toBeNull();
    expect(session?.id).toBe(second.id);
    expect(session?.type).toBe("iching");
    expect(session?.id).not.toBe(first.id);
  });

  it("endSession removes the session (getSession returns null after)", () => {
    service.startTarotReading(ENTITY_A, ROOM_1, "three_card", "Test");

    expect(service.getSession(ENTITY_A, ROOM_1)).not.toBeNull();

    service.endSession(ENTITY_A, ROOM_1);

    expect(service.getSession(ENTITY_A, ROOM_1)).toBeNull();
  });

  it("multiple concurrent sessions for different entity+room pairs work independently", () => {
    const sessionA1 = service.startTarotReading(ENTITY_A, ROOM_1, "single", "Question A1");
    const sessionA2 = service.startIChingReading(ENTITY_A, ROOM_2, "Question A2");
    const sessionB1 = service.startAstrologyReading(ENTITY_B, ROOM_1, TEST_BIRTH_DATA);

    // All three sessions exist independently
    const retrievedA1 = service.getSession(ENTITY_A, ROOM_1);
    const retrievedA2 = service.getSession(ENTITY_A, ROOM_2);
    const retrievedB1 = service.getSession(ENTITY_B, ROOM_1);

    expect(retrievedA1).not.toBeNull();
    expect(retrievedA2).not.toBeNull();
    expect(retrievedB1).not.toBeNull();

    expect(retrievedA1?.id).toBe(sessionA1.id);
    expect(retrievedA2?.id).toBe(sessionA2.id);
    expect(retrievedB1?.id).toBe(sessionB1.id);

    expect(retrievedA1?.type).toBe("tarot");
    expect(retrievedA2?.type).toBe("iching");
    expect(retrievedB1?.type).toBe("astrology");

    // Ending one does not affect the others
    service.endSession(ENTITY_A, ROOM_1);
    expect(service.getSession(ENTITY_A, ROOM_1)).toBeNull();
    expect(service.getSession(ENTITY_A, ROOM_2)).not.toBeNull();
    expect(service.getSession(ENTITY_B, ROOM_1)).not.toBeNull();
  });
});

// ──────────────────────────────────────────────
// Reading Flow — Tarot
// ──────────────────────────────────────────────

describe("Reading Flow — Tarot", () => {
  let service: MysticismService;

  beforeEach(() => {
    service = new MysticismService();
  });

  it("getNextReveal returns first card prompt after starting tarot reading", () => {
    service.startTarotReading(ENTITY_A, ROOM_1, "single", "Tell me about my path");

    const reveal = service.getNextReveal(ENTITY_A, ROOM_1);

    expect(reveal).not.toBeNull();
    expect(reveal?.prompt).toBeTypeOf("string");
    expect(reveal?.prompt.length).toBeGreaterThan(0);
    expect(reveal?.element).toBeTypeOf("string");
    expect(reveal?.element.length).toBeGreaterThan(0);
  });

  it("getNextReveal prompt contains card data and question", () => {
    service.startTarotReading(ENTITY_A, ROOM_1, "single", "Tell me about love");

    const reveal = service.getNextReveal(ENTITY_A, ROOM_1);
    expect(reveal).not.toBeNull();

    // The prompt should reference the querent's question
    const promptLower = reveal?.prompt.toLowerCase();
    expect(promptLower).toContain("love");
  });

  it("recordFeedback advances to next card", () => {
    service.startTarotReading(ENTITY_A, ROOM_1, "three_card", "What about my career?");

    const firstReveal = service.getNextReveal(ENTITY_A, ROOM_1);
    expect(firstReveal).not.toBeNull();
    const firstElement = firstReveal?.element;

    // Record feedback to advance
    service.recordFeedback(ENTITY_A, ROOM_1, makeFeedback(firstElement));

    const secondReveal = service.getNextReveal(ENTITY_A, ROOM_1);
    expect(secondReveal).not.toBeNull();
    // Second card should be different from the first
    expect(secondReveal?.element).not.toBe(firstElement);
  });

  it("after revealing all cards, getNextReveal returns null", () => {
    service.startTarotReading(ENTITY_A, ROOM_1, "single", "Quick question");

    // Reveal the only card
    const reveal = service.getNextReveal(ENTITY_A, ROOM_1);
    expect(reveal).not.toBeNull();

    // Record feedback to advance past the single card
    service.recordFeedback(ENTITY_A, ROOM_1, makeFeedback(reveal?.element));

    // No more cards
    const next = service.getNextReveal(ENTITY_A, ROOM_1);
    expect(next).toBeNull();
  });

  it("getSynthesis returns a prompt after all cards revealed", () => {
    service.startTarotReading(ENTITY_A, ROOM_1, "single", "What is my purpose?");

    // Reveal and give feedback for the single card
    const reveal = service.getNextReveal(ENTITY_A, ROOM_1);
    expect(reveal).not.toBeNull();
    service.recordFeedback(ENTITY_A, ROOM_1, makeFeedback(reveal?.element));

    const synthesis = service.getSynthesis(ENTITY_A, ROOM_1);
    expect(synthesis).not.toBeNull();
    expect(synthesis?.length).toBeGreaterThan(0);
    expect(synthesis).toBeTypeOf("string");
  });

  it("getSynthesis returns null when session doesn't exist", () => {
    const synthesis = service.getSynthesis(ENTITY_A, ROOM_1);
    expect(synthesis).toBeNull();
  });

  it("getDeepeningPrompt returns a prompt string for a valid revealed card", () => {
    service.startTarotReading(ENTITY_A, ROOM_1, "single", "Deepen this");

    // Reveal the card and record feedback
    const reveal = service.getNextReveal(ENTITY_A, ROOM_1);
    expect(reveal).not.toBeNull();
    service.recordFeedback(ENTITY_A, ROOM_1, makeFeedback(reveal?.element));

    // Deepen card at index 0 (which has been revealed)
    const deepening = service.getDeepeningPrompt(
      ENTITY_A,
      ROOM_1,
      0,
      "Tell me more about this card's meaning for my relationships."
    );

    expect(deepening).not.toBeNull();
    expect(deepening).toBeTypeOf("string");
    expect(deepening?.length).toBeGreaterThan(0);
  });

  it("getDeepeningPrompt returns null for non-tarot sessions", () => {
    service.startIChingReading(ENTITY_A, ROOM_1, "I Ching question");

    const deepening = service.getDeepeningPrompt(ENTITY_A, ROOM_1, 0, "Tell me more");
    expect(deepening).toBeNull();
  });
});

// ──────────────────────────────────────────────
// Reading Flow — I Ching
// ──────────────────────────────────────────────

describe("Reading Flow — I Ching", () => {
  let service: MysticismService;

  beforeEach(() => {
    service = new MysticismService();
  });

  it("getNextReveal reveals changing lines (if any)", () => {
    // I Ching readings are random; changing lines may or may not exist.
    // We start a reading and check that getNextReveal either returns
    // a line reveal (if there are changing lines) or null (if no changing lines).
    const session = service.startIChingReading(ENTITY_A, ROOM_1, "What is changing?");
    const changingLines = session.iching?.castResult.changingLines;

    const reveal = service.getNextReveal(ENTITY_A, ROOM_1);

    if (changingLines.length > 0) {
      expect(reveal).not.toBeNull();
      expect(reveal?.prompt).toBeTypeOf("string");
      expect(reveal?.prompt.length).toBeGreaterThan(0);
      // Element should indicate a line position
      expect(reveal?.element).toMatch(/^Line \d+$/);
    } else {
      // No changing lines means nothing to reveal
      expect(reveal).toBeNull();
    }
  });

  it("full I Ching reading lifecycle: start -> reveal all lines -> synthesize", () => {
    const session = service.startIChingReading(ENTITY_A, ROOM_1, "Guide me forward");
    const changingLineCount = session.iching?.castResult.changingLines.length;

    // Reveal all changing lines with feedback
    let revealed = 0;
    let reveal = service.getNextReveal(ENTITY_A, ROOM_1);
    while (reveal !== null) {
      expect(reveal.prompt).toBeTypeOf("string");
      expect(reveal.element).toMatch(/^Line \d+$/);
      service.recordFeedback(ENTITY_A, ROOM_1, makeFeedback(reveal.element));
      revealed++;
      reveal = service.getNextReveal(ENTITY_A, ROOM_1);
    }

    expect(revealed).toBe(changingLineCount);

    // Synthesis should be available
    const synthesis = service.getSynthesis(ENTITY_A, ROOM_1);
    expect(synthesis).not.toBeNull();
    expect(synthesis).toBeTypeOf("string");
    expect(synthesis?.length).toBeGreaterThan(0);
  });
});

// ──────────────────────────────────────────────
// Reading Flow — Astrology
// ──────────────────────────────────────────────

describe("Reading Flow — Astrology", () => {
  let service: MysticismService;

  beforeEach(() => {
    service = new MysticismService();
  });

  it("getNextReveal returns overview then sun then moon", () => {
    service.startAstrologyReading(ENTITY_A, ROOM_1, TEST_BIRTH_DATA);

    // First reveal: overview
    const overview = service.getNextReveal(ENTITY_A, ROOM_1);
    expect(overview).not.toBeNull();
    expect(overview?.element).toBe("overview");
    expect(overview?.prompt).toBeTypeOf("string");
    expect(overview?.prompt.length).toBeGreaterThan(0);

    // Record feedback to continue
    service.recordFeedback(ENTITY_A, ROOM_1, makeFeedback("overview"));

    // Second reveal: sun
    const sun = service.getNextReveal(ENTITY_A, ROOM_1);
    expect(sun).not.toBeNull();
    expect(sun?.element).toBe("sun");

    service.recordFeedback(ENTITY_A, ROOM_1, makeFeedback("sun"));

    // Third reveal: moon
    const moon = service.getNextReveal(ENTITY_A, ROOM_1);
    expect(moon).not.toBeNull();
    expect(moon?.element).toBe("moon");
  });

  it("full astrology reading lifecycle through all planets", () => {
    service.startAstrologyReading(ENTITY_A, ROOM_1, TEST_BIRTH_DATA);

    const expectedOrder = [
      "overview",
      "sun",
      "moon",
      "ascendant",
      "mercury",
      "venus",
      "mars",
      "jupiter",
      "saturn",
      "uranus",
      "neptune",
      "pluto",
    ];

    const revealedElements: string[] = [];

    let reveal = service.getNextReveal(ENTITY_A, ROOM_1);
    while (reveal !== null) {
      revealedElements.push(reveal.element);
      expect(reveal.prompt).toBeTypeOf("string");
      expect(reveal.prompt.length).toBeGreaterThan(0);

      service.recordFeedback(ENTITY_A, ROOM_1, makeFeedback(reveal.element));
      reveal = service.getNextReveal(ENTITY_A, ROOM_1);
    }

    expect(revealedElements).toEqual(expectedOrder);

    // Synthesis should be available after all reveals
    const synthesis = service.getSynthesis(ENTITY_A, ROOM_1);
    expect(synthesis).not.toBeNull();
    expect(synthesis).toBeTypeOf("string");
    expect(synthesis?.length).toBeGreaterThan(0);
  });
});

// ──────────────────────────────────────────────
// Payment Tracking
// ──────────────────────────────────────────────

describe("Payment Tracking", () => {
  let service: MysticismService;

  beforeEach(() => {
    service = new MysticismService();
  });

  it("recordPayment stores and getPaymentHistory retrieves payments", () => {
    const payment = makePayment(ENTITY_A, "tarot");
    service.recordPayment(payment);

    const history = service.getPaymentHistory(ENTITY_A);
    expect(history).toHaveLength(1);
    expect(history[0].id).toBe(payment.id);
    expect(history[0].entityId).toBe(ENTITY_A);
    expect(history[0].system).toBe("tarot");
    expect(history[0].amount).toBe("0.01");
  });

  it("getPaymentHistory returns empty array for unknown entity", () => {
    const history = service.getPaymentHistory("entity-unknown-999");
    expect(history).toEqual([]);
  });

  it("multiple payments for same entity accumulate", () => {
    service.recordPayment(makePayment(ENTITY_A, "tarot", "0.01"));
    service.recordPayment(makePayment(ENTITY_A, "iching", "0.01"));
    service.recordPayment(makePayment(ENTITY_A, "astrology", "0.02"));

    const history = service.getPaymentHistory(ENTITY_A);
    expect(history).toHaveLength(3);
    expect(history[0].system).toBe("tarot");
    expect(history[1].system).toBe("iching");
    expect(history[2].system).toBe("astrology");
  });

  it("getPricing returns default values", () => {
    const pricing = service.getPricing();
    expect(pricing).toEqual({
      tarot: "0.01",
      iching: "0.01",
      astrology: "0.02",
    });
  });
});

// ──────────────────────────────────────────────
// Crisis Detection
// ──────────────────────────────────────────────

describe("Crisis Detection", () => {
  let service: MysticismService;

  beforeEach(() => {
    service = new MysticismService();
  });

  // ─── HIGH severity ─────────────────────────

  it('"kill myself" triggers HIGH severity', () => {
    const result = service.detectCrisis("I want to kill myself");
    expect(result.detected).toBe(true);
    expect(result.severity).toBe("high");
    expect(result.keywords).toContain("kill myself");
  });

  it('"suicide" triggers HIGH severity', () => {
    const result = service.detectCrisis("I'm thinking about suicide");
    expect(result.detected).toBe(true);
    expect(result.severity).toBe("high");
    expect(result.keywords).toContain("suicide");
  });

  it('"end it all" triggers HIGH severity', () => {
    const result = service.detectCrisis("I just want to end it all");
    expect(result.detected).toBe(true);
    expect(result.severity).toBe("high");
    expect(result.keywords).toContain("end it all");
  });

  it('"want to die" triggers HIGH severity', () => {
    const result = service.detectCrisis("I want to die");
    expect(result.detected).toBe(true);
    expect(result.severity).toBe("high");
    expect(result.keywords).toContain("want to die");
  });

  // ─── MEDIUM severity ───────────────────────

  it('"self-harm" triggers MEDIUM severity', () => {
    const result = service.detectCrisis("I've been thinking about self-harm");
    expect(result.detected).toBe(true);
    expect(result.severity).toBe("medium");
    expect(result.keywords).toContain("self-harm");
  });

  it('"hurt myself" triggers MEDIUM severity', () => {
    const result = service.detectCrisis("I want to hurt myself");
    expect(result.detected).toBe(true);
    expect(result.severity).toBe("medium");
    expect(result.keywords).toContain("hurt myself");
  });

  it('"hopeless" triggers MEDIUM severity', () => {
    const result = service.detectCrisis("Everything feels hopeless");
    expect(result.detected).toBe(true);
    expect(result.severity).toBe("medium");
    expect(result.keywords).toContain("hopeless");
  });

  // ─── LOW severity ──────────────────────────

  it('"depressed" triggers LOW severity', () => {
    const result = service.detectCrisis("I've been feeling really depressed lately");
    expect(result.detected).toBe(true);
    expect(result.severity).toBe("low");
    expect(result.keywords).toContain("depressed");
  });

  it('"feeling down" returns detected=false (not a crisis keyword)', () => {
    // "feeling down" is not in the keyword lists, so it should not be detected
    const result = service.detectCrisis("I'm feeling down today");
    expect(result.detected).toBe(false);
  });

  // ─── Edge cases ────────────────────────────

  it('normal text ("I\'m curious about my future") returns detected=false', () => {
    const result = service.detectCrisis("I'm curious about my future");
    expect(result.detected).toBe(false);
    expect(result.severity).toBe("low");
    expect(result.keywords).toEqual([]);
    expect(result.recommendedAction).toBe("");
  });

  it('mixed case "KILL MYSELF" still triggers (case insensitive)', () => {
    const result = service.detectCrisis("I WANT TO KILL MYSELF");
    expect(result.detected).toBe(true);
    expect(result.severity).toBe("high");
    expect(result.keywords).toContain("kill myself");
  });

  it("crisis keywords embedded in longer text are still detected", () => {
    const result = service.detectCrisis(
      "So last night I was reading a book and started thinking about how I want to die peacefully in my sleep someday"
    );
    expect(result.detected).toBe(true);
    expect(result.severity).toBe("high");
    expect(result.keywords).toContain("want to die");
  });

  it("recommendedAction is non-empty when detected=true", () => {
    // Test across all severity levels
    const high = service.detectCrisis("I want to kill myself");
    expect(high.detected).toBe(true);
    expect(high.recommendedAction.length).toBeGreaterThan(0);

    const medium = service.detectCrisis("I feel hopeless");
    expect(medium.detected).toBe(true);
    expect(medium.recommendedAction.length).toBeGreaterThan(0);

    const low = service.detectCrisis("I feel depressed");
    expect(low.detected).toBe(true);
    expect(low.recommendedAction.length).toBeGreaterThan(0);
  });

  it('recommendedAction contains "988" for HIGH severity', () => {
    const result = service.detectCrisis("I am going to kill myself");
    expect(result.detected).toBe(true);
    expect(result.severity).toBe("high");
    expect(result.recommendedAction).toContain("988");
  });
});
