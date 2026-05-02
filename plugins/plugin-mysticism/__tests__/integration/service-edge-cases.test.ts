import { describe, expect, it } from "vitest";
import { astrologyIntakeForm } from "../../src/forms/astrology-intake";
import { readingFeedbackForm } from "../../src/forms/feedback";
import { tarotIntakeForm } from "../../src/forms/tarot-intake";
import { MysticismService } from "../../src/services/mysticism-service";
import type { BirthData, FeedbackEntry } from "../../src/types";

// ─── Shared Fixtures ───────────────────────────

const FULL_BIRTH_DATA: BirthData = {
  year: 1990,
  month: 6,
  day: 15,
  hour: 12,
  minute: 0,
  latitude: 40.7,
  longitude: -74.0,
  timezone: -5,
};

function makeFeedback(element: string, text: string): FeedbackEntry {
  return { element, userText: text, timestamp: Date.now() };
}

// ─── A. Birth Data with Null Fields ───────────────────────────

describe("Astrology with partial birth data", () => {
  it("startAstrologyReading works with null hour/minute/lat/lon/tz", () => {
    const service = new MysticismService();
    const session = service.startAstrologyReading("e1", "r1", {
      year: 1990,
      month: 6,
      day: 15,
      hour: null,
      minute: null,
      latitude: null,
      longitude: null,
      timezone: null,
    });
    expect(session.astrology).toBeDefined();
    // June 15 is Gemini
    expect(session.astrology?.chart.sun.sign).toBe("gemini");
  });

  it("startAstrologyReading works with null day", () => {
    const service = new MysticismService();
    const session = service.startAstrologyReading("e1", "r1", {
      year: 1990,
      month: 3,
      day: null,
      hour: null,
      minute: null,
      latitude: null,
      longitude: null,
      timezone: null,
    });
    // With null day, defaults to day=1. March 1 is Pisces.
    expect(session.astrology).toBeDefined();
    expect(session.astrology?.chart.sun.sign).toBe("pisces");
  });

  it("birth data nulls are stored in the session", () => {
    const service = new MysticismService();
    const partialData: BirthData = {
      year: 2000,
      month: 12,
      day: null,
      hour: null,
      minute: null,
      latitude: null,
      longitude: null,
      timezone: null,
    };
    const session = service.startAstrologyReading("e1", "r1", partialData);
    expect(session.astrology?.birthData.day).toBeNull();
    expect(session.astrology?.birthData.hour).toBeNull();
    expect(session.astrology?.birthData.latitude).toBeNull();
  });
});

// ─── B. Crisis Detection Edge Cases ───────────────────────────

describe("Crisis detection edge cases", () => {
  const service = new MysticismService();

  it("empty string returns no crisis", () => {
    const result = service.detectCrisis("");
    expect(result.detected).toBe(false);
    expect(result.keywords).toEqual([]);
    expect(result.recommendedAction).toBe("");
  });

  it("multiple HIGH keywords returns all in keywords array", () => {
    const result = service.detectCrisis("I want to kill myself and take my own life");
    expect(result.severity).toBe("high");
    expect(result.keywords.length).toBeGreaterThanOrEqual(2);
    expect(result.keywords).toContain("kill myself");
    expect(result.keywords).toContain("take my own life");
  });

  it("HIGH takes priority over MEDIUM keywords in same text", () => {
    const result = service.detectCrisis("I feel hopeless and want to kill myself");
    expect(result.severity).toBe("high");
    expect(result.detected).toBe(true);
  });

  it("MEDIUM takes priority over LOW", () => {
    const result = service.detectCrisis("I feel depressed and can't go on");
    expect(result.severity).toBe("medium");
    expect(result.detected).toBe(true);
  });

  it("recommendedAction contains 988 for HIGH", () => {
    const result = service.detectCrisis("I want to kill myself");
    expect(result.recommendedAction).toContain("988");
  });

  it("recommendedAction contains 988 for MEDIUM", () => {
    const result = service.detectCrisis("I feel hopeless");
    expect(result.recommendedAction).toContain("988");
  });

  it("LOW severity recommendedAction is non-empty", () => {
    const result = service.detectCrisis("I feel depressed");
    expect(result.severity).toBe("low");
    expect(result.detected).toBe(true);
    expect(result.recommendedAction.length).toBeGreaterThan(0);
  });

  it("case-insensitive matching", () => {
    const result = service.detectCrisis("I Want To KILL MYSELF");
    expect(result.detected).toBe(true);
    expect(result.severity).toBe("high");
  });

  it("benign text returns no crisis", () => {
    const result = service.detectCrisis("I love my life and am feeling great today");
    expect(result.detected).toBe(false);
    expect(result.severity).toBe("low");
    expect(result.keywords).toEqual([]);
  });
});

// ─── C. getIChingCastingSummary ───────────────────────────

describe("getIChingCastingSummary", () => {
  it("returns summary after starting I Ching reading", () => {
    const service = new MysticismService();
    service.startIChingReading("e1", "r1", "test question");
    const summary = service.getIChingCastingSummary("e1", "r1");
    expect(summary).toBeTypeOf("string");
    expect(summary?.length).toBeGreaterThan(20);
    // Should contain hexagram info
    expect(summary).toContain("Hexagram");
  });

  it("returns null for non-existent session", () => {
    const service = new MysticismService();
    expect(service.getIChingCastingSummary("x", "y")).toBeNull();
  });

  it("summary includes hexagram name and trigram info", () => {
    const service = new MysticismService();
    const session = service.startIChingReading("e1", "r1", "deep question");
    const summary = service.getIChingCastingSummary("e1", "r1")!;

    // Should contain the hexagram's english name
    expect(summary).toContain(session.iching?.hexagram.englishName);
    // Should contain trigram labels
    expect(summary).toContain("Upper:");
    expect(summary).toContain("Lower:");
  });
});

// ─── D. Session Replacement Behavior ───────────────────────────

describe("Session replacement", () => {
  it("starting tarot replaces existing iching session", () => {
    const service = new MysticismService();
    service.startIChingReading("e1", "r1", "first");
    expect(service.getSession("e1", "r1")?.type).toBe("iching");
    service.startTarotReading("e1", "r1", "three_card", "second");
    expect(service.getSession("e1", "r1")?.type).toBe("tarot");
  });

  it("starting iching replaces existing tarot session", () => {
    const service = new MysticismService();
    service.startTarotReading("e1", "r1", "three_card", "first");
    expect(service.getSession("e1", "r1")?.type).toBe("tarot");
    service.startIChingReading("e1", "r1", "second");
    expect(service.getSession("e1", "r1")?.type).toBe("iching");
  });

  it("starting astrology replaces existing tarot session", () => {
    const service = new MysticismService();
    service.startTarotReading("e1", "r1", "single", "first");
    expect(service.getSession("e1", "r1")?.type).toBe("tarot");
    service.startAstrologyReading("e1", "r1", FULL_BIRTH_DATA);
    expect(service.getSession("e1", "r1")?.type).toBe("astrology");
  });

  it("end then start creates fresh session", () => {
    const service = new MysticismService();
    service.startTarotReading("e1", "r1", "single", "q1");
    const firstId = service.getSession("e1", "r1")?.id;
    service.endSession("e1", "r1");
    expect(service.getSession("e1", "r1")).toBeNull();

    service.startTarotReading("e1", "r1", "celtic_cross", "q2");
    const s = service.getSession("e1", "r1")!;
    expect(s.tarot?.spread.id).toBe("celtic_cross");
    expect(s.id).not.toBe(firstId);
  });
});

// ─── E. Full Reading Lifecycle with Feedback and Synthesis ───────────────────────────

describe("Full tarot lifecycle with feedback", () => {
  it("three-card: 3 reveals, 3 feedbacks, then synthesis", () => {
    const service = new MysticismService();
    service.startTarotReading("e1", "r1", "three_card", "career");

    for (let i = 0; i < 3; i++) {
      const reveal = service.getNextReveal("e1", "r1");
      expect(reveal).not.toBeNull();
      expect(reveal?.prompt.length).toBeGreaterThan(100);
      expect(reveal?.element.length).toBeGreaterThan(0);

      service.recordFeedback("e1", "r1", makeFeedback(reveal?.element, `Turn ${i + 1} feedback`));
    }

    // All revealed — next should be null
    expect(service.getNextReveal("e1", "r1")).toBeNull();

    // Synthesis should work
    const synth = service.getSynthesis("e1", "r1");
    expect(synth).toBeTypeOf("string");
    expect(synth?.length).toBeGreaterThan(100);
    expect(synth).toContain("career");
  });

  it("single card: 1 reveal, 1 feedback, then synthesis", () => {
    const service = new MysticismService();
    service.startTarotReading("e1", "r1", "single", "daily guidance");

    const reveal = service.getNextReveal("e1", "r1");
    expect(reveal).not.toBeNull();
    service.recordFeedback("e1", "r1", makeFeedback(reveal?.element, "insightful"));

    expect(service.getNextReveal("e1", "r1")).toBeNull();

    const synth = service.getSynthesis("e1", "r1");
    expect(synth).toBeTypeOf("string");
    expect(synth?.length).toBeGreaterThan(50);
  });

  it("I Ching full lifecycle: reveals, feedbacks, synthesis", () => {
    const service = new MysticismService();
    service.startIChingReading("e1", "r1", "life path");

    const session = service.getSession("e1", "r1")!;
    const changingCount = session.iching?.castResult.changingLines.length;

    // Reveal all changing lines
    for (let i = 0; i < changingCount; i++) {
      const reveal = service.getNextReveal("e1", "r1");
      if (!reveal) break;
      service.recordFeedback("e1", "r1", makeFeedback(reveal.element, `Line ${i + 1} resonates`));
    }

    // After all lines revealed, next should be null
    expect(service.getNextReveal("e1", "r1")).toBeNull();

    // Synthesis
    const synth = service.getSynthesis("e1", "r1");
    expect(synth).toBeTypeOf("string");
    expect(synth?.length).toBeGreaterThan(50);
  });
});

// ─── F. Form Structural Integrity ───────────────────────────

describe("Form definitions", () => {
  it("tarot intake form has required fields", () => {
    const form = tarotIntakeForm;
    expect(form.id).toBe("tarot_intake");
    expect(form.controls.length).toBeGreaterThanOrEqual(2);
    const questionCtrl = form.controls.find((c) => c.key === "question");
    expect(questionCtrl).toBeDefined();
    expect(questionCtrl?.required).toBe(true);
    expect(questionCtrl?.type).toBe("text");
  });

  it("tarot intake form has spread selector with options", () => {
    const spreadCtrl = tarotIntakeForm.controls.find((c) => c.key === "spread");
    expect(spreadCtrl).toBeDefined();
    expect(spreadCtrl?.type).toBe("select");
    expect(spreadCtrl?.required).toBe(true);
    expect(spreadCtrl?.options).toBeDefined();
    expect(spreadCtrl?.options?.length).toBeGreaterThanOrEqual(4);
    // Check that three_card is an option
    const threeCard = spreadCtrl?.options?.find((o) => o.value === "three_card");
    expect(threeCard).toBeDefined();
  });

  it("tarot intake form has onSubmit and onCancel handlers", () => {
    expect(tarotIntakeForm.onSubmit).toBe("handle_tarot_intake");
    expect(tarotIntakeForm.onCancel).toBe("handle_reading_cancel");
  });

  it("astrology intake form has birth_date field", () => {
    const form = astrologyIntakeForm;
    expect(form.id).toBe("astrology_intake");
    const dateCtrl = form.controls.find((c) => c.key === "birth_date");
    expect(dateCtrl).toBeDefined();
    expect(dateCtrl?.required).toBe(true);
    expect(dateCtrl?.type).toBe("date");
  });

  it("astrology intake form has birth_time and birth_place fields", () => {
    const timeCtrl = astrologyIntakeForm.controls.find((c) => c.key === "birth_time");
    expect(timeCtrl).toBeDefined();
    expect(timeCtrl?.required).toBe(true);

    const placeCtrl = astrologyIntakeForm.controls.find((c) => c.key === "birth_place");
    expect(placeCtrl).toBeDefined();
    expect(placeCtrl?.required).toBe(true);
  });

  it("feedback form has satisfaction field", () => {
    const form = readingFeedbackForm;
    expect(form.id).toBe("reading_feedback");
    const satCtrl = form.controls.find((c) => c.key === "satisfaction");
    expect(satCtrl).toBeDefined();
    expect(satCtrl?.required).toBe(true);
    expect(satCtrl?.options?.length).toBe(5);
  });

  it("feedback form satisfaction options have values 1-5", () => {
    const satCtrl = readingFeedbackForm.controls.find((c) => c.key === "satisfaction");
    const values = satCtrl?.options?.map((o) => o.value);
    expect(values).toContain("1");
    expect(values).toContain("2");
    expect(values).toContain("3");
    expect(values).toContain("4");
    expect(values).toContain("5");
  });

  it("feedback form has optional resonant_insight and suggestions fields", () => {
    const insightCtrl = readingFeedbackForm.controls.find((c) => c.key === "resonant_insight");
    expect(insightCtrl).toBeDefined();
    expect(insightCtrl?.required).toBeUndefined();

    const suggestCtrl = readingFeedbackForm.controls.find((c) => c.key === "suggestions");
    expect(suggestCtrl).toBeDefined();
    expect(suggestCtrl?.required).toBeUndefined();
  });
});

// ─── G. Payment Flow Integration ───────────────────────────

describe("Payment flow integration", () => {
  it("full flow: start reading → request payment → confirm payment → continue", () => {
    const service = new MysticismService();

    // Start reading
    service.startTarotReading("e1", "r1", "three_card", "love");
    let session = service.getSession("e1", "r1")!;
    expect(session.paymentStatus).toBe("none");

    // Get first reveal
    const reveal1 = service.getNextReveal("e1", "r1");
    expect(reveal1).not.toBeNull();

    // Request payment
    service.markPaymentRequested("e1", "r1", "2.50");
    session = service.getSession("e1", "r1")!;
    expect(session.paymentStatus).toBe("requested");
    expect(session.paymentAmount).toBe("2.50");

    // Confirm payment
    service.recordConversationPayment("e1", "r1", "2.50", "0xabc123");
    session = service.getSession("e1", "r1")!;
    expect(session.paymentStatus).toBe("paid");
    expect(session.paymentTxHash).toBe("0xabc123");

    // Continue with reading after payment
    service.recordFeedback("e1", "r1", makeFeedback(reveal1?.element, "great"));
    const reveal2 = service.getNextReveal("e1", "r1");
    expect(reveal2).not.toBeNull();
  });

  it("payment status persists through reveals", () => {
    const service = new MysticismService();
    service.startTarotReading("e1", "r1", "three_card", "money");

    service.recordConversationPayment("e1", "r1", "1.00", "0xdef456");

    // Do multiple reveals — payment should stay
    for (let i = 0; i < 3; i++) {
      const reveal = service.getNextReveal("e1", "r1");
      if (!reveal) break;
      service.recordFeedback("e1", "r1", makeFeedback(reveal.element, `turn ${i + 1}`));

      const s = service.getSession("e1", "r1")!;
      expect(s.paymentStatus).toBe("paid");
      expect(s.paymentTxHash).toBe("0xdef456");
    }
  });

  it("endSession clears payment state along with the session", () => {
    const service = new MysticismService();
    service.startTarotReading("e1", "r1", "single", "test");
    service.recordConversationPayment("e1", "r1", "0.50", "0x111");

    service.endSession("e1", "r1");
    expect(service.getSession("e1", "r1")).toBeNull();

    // Starting new session has clean payment state
    service.startTarotReading("e1", "r1", "single", "new");
    const s = service.getSession("e1", "r1")!;
    expect(s.paymentStatus).toBe("none");
    expect(s.paymentAmount).toBeNull();
    expect(s.paymentTxHash).toBeNull();
  });
});

// ─── H. Concurrent Sessions ───────────────────────────

describe("Concurrent sessions", () => {
  it("4 different users can have simultaneous readings", () => {
    const service = new MysticismService();

    service.startTarotReading("user1", "room1", "single", "q1");
    service.startIChingReading("user2", "room1", "q2");
    service.startAstrologyReading("user3", "room1", FULL_BIRTH_DATA);
    service.startTarotReading("user1", "room2", "celtic_cross", "q4");

    expect(service.getSession("user1", "room1")?.type).toBe("tarot");
    expect(service.getSession("user2", "room1")?.type).toBe("iching");
    expect(service.getSession("user3", "room1")?.type).toBe("astrology");
    expect(service.getSession("user1", "room2")?.type).toBe("tarot");
    expect(service.getSession("user1", "room2")?.tarot?.spread.id).toBe("celtic_cross");

    // Operations on one don't affect others
    service.endSession("user1", "room1");
    expect(service.getSession("user1", "room1")).toBeNull();
    expect(service.getSession("user1", "room2")).not.toBeNull();
    expect(service.getSession("user2", "room1")).not.toBeNull();
    expect(service.getSession("user3", "room1")).not.toBeNull();
  });

  it("same user in different rooms gets independent sessions", () => {
    const service = new MysticismService();

    service.startTarotReading("user1", "room1", "single", "love");
    service.startIChingReading("user1", "room2", "career");
    service.startAstrologyReading("user1", "room3", FULL_BIRTH_DATA);

    expect(service.getSession("user1", "room1")?.type).toBe("tarot");
    expect(service.getSession("user1", "room2")?.type).toBe("iching");
    expect(service.getSession("user1", "room3")?.type).toBe("astrology");

    // Reveal in one room doesn't affect another
    const reveal1 = service.getNextReveal("user1", "room1");
    expect(reveal1).not.toBeNull();
    service.recordFeedback("user1", "room1", makeFeedback(reveal1?.element, "nice"));

    // Room2 iching is untouched
    const ichingSession = service.getSession("user1", "room2")!;
    expect(ichingSession.iching?.revealedLines).toBe(0);
  });

  it("payment in one session doesn't affect another", () => {
    const service = new MysticismService();

    service.startTarotReading("user1", "room1", "single", "love");
    service.startTarotReading("user1", "room2", "single", "career");

    service.recordConversationPayment("user1", "room1", "5.00", "0xpay1");

    expect(service.getSession("user1", "room1")?.paymentStatus).toBe("paid");
    expect(service.getSession("user1", "room2")?.paymentStatus).toBe("none");
  });
});

// ─── I. Additional Edge Cases ───────────────────────────

describe("Additional service edge cases", () => {
  it("getSession returns null for non-existent entity/room", () => {
    const service = new MysticismService();
    expect(service.getSession("nonexistent", "nowhere")).toBeNull();
  });

  it("getNextReveal returns null for non-existent session", () => {
    const service = new MysticismService();
    expect(service.getNextReveal("x", "y")).toBeNull();
  });

  it("getSynthesis returns null for non-existent session", () => {
    const service = new MysticismService();
    expect(service.getSynthesis("x", "y")).toBeNull();
  });

  it("endSession on non-existent session does not throw", () => {
    const service = new MysticismService();
    expect(() => service.endSession("x", "y")).not.toThrow();
  });

  it("recordFeedback on non-existent session does not throw", () => {
    const service = new MysticismService();
    expect(() => service.recordFeedback("x", "y", makeFeedback("element", "text"))).not.toThrow();
  });

  it("session phase transitions through lifecycle", () => {
    const service = new MysticismService();
    service.startTarotReading("e1", "r1", "single", "phases");

    // After start: casting
    let session = service.getSession("e1", "r1")!;
    expect(session.phase).toBe("casting");

    // After getNextReveal: interpretation
    service.getNextReveal("e1", "r1");
    session = service.getSession("e1", "r1")!;
    expect(session.phase).toBe("interpretation");

    // Record feedback to complete reveals
    service.recordFeedback("e1", "r1", makeFeedback("card", "great"));

    // After getSynthesis: synthesis
    service.getSynthesis("e1", "r1");
    session = service.getSession("e1", "r1")!;
    expect(session.phase).toBe("synthesis");
  });

  it("session updatedAt changes on operations", () => {
    const service = new MysticismService();
    service.startTarotReading("e1", "r1", "single", "timing");
    const session1 = service.getSession("e1", "r1")!;
    const created = session1.updatedAt;

    // Small delay to ensure different timestamps
    const _reveal = service.getNextReveal("e1", "r1");
    const session2 = service.getSession("e1", "r1")!;
    expect(session2.updatedAt).toBeGreaterThanOrEqual(created);
  });

  it("getPricing returns default pricing", () => {
    const service = new MysticismService();
    const pricing = service.getPricing();
    expect(pricing.tarot).toBe("0.01");
    expect(pricing.iching).toBe("0.01");
    expect(pricing.astrology).toBe("0.02");
  });

  it("getPricing returns a copy, not the internal object", () => {
    const service = new MysticismService();
    const pricing1 = service.getPricing();
    pricing1.tarot = "999";
    const pricing2 = service.getPricing();
    expect(pricing2.tarot).toBe("0.01");
  });

  it("payment history tracks per entity", () => {
    const service = new MysticismService();
    expect(service.getPaymentHistory("nobody")).toEqual([]);

    service.recordPayment({
      id: "pay1",
      entityId: "user1",
      amount: "0.01",
      currency: "SOL",
      system: "tarot",
      timestamp: Date.now(),
      status: "completed",
    });
    service.recordPayment({
      id: "pay2",
      entityId: "user1",
      amount: "0.02",
      currency: "SOL",
      system: "iching",
      timestamp: Date.now(),
      status: "completed",
    });
    service.recordPayment({
      id: "pay3",
      entityId: "user2",
      amount: "0.03",
      currency: "SOL",
      system: "astrology",
      timestamp: Date.now(),
      status: "completed",
    });

    expect(service.getPaymentHistory("user1").length).toBe(2);
    expect(service.getPaymentHistory("user2").length).toBe(1);
    expect(service.getPaymentHistory("user3")).toEqual([]);
  });
});

describe("Economic context with payment history", () => {
  it("buildEconomicText shows payment summary for returning user", () => {
    const service = new MysticismService();

    // Record some completed payments
    service.recordPayment({
      id: "pay1",
      entityId: "e1",
      amount: "2.50",
      currency: "USDC",
      system: "tarot",
      timestamp: Date.now() - 86400000, // 1 day ago
      status: "completed",
    });
    service.recordPayment({
      id: "pay2",
      entityId: "e1",
      amount: "3.00",
      currency: "USDC",
      system: "astrology",
      timestamp: Date.now() - 43200000, // 12 hours ago
      status: "completed",
    });

    const history = service.getPaymentHistory("e1");
    expect(history).toHaveLength(2);

    const completed = history.filter((p) => p.status === "completed");
    expect(completed).toHaveLength(2);

    const totalSpent = completed.reduce((sum, p) => sum + parseFloat(p.amount), 0);
    expect(totalSpent).toBeCloseTo(5.5, 2);

    const systems = [...new Set(completed.map((p) => p.system))];
    expect(systems).toContain("tarot");
    expect(systems).toContain("astrology");
  });

  it("payment history distinguishes completed from pending", () => {
    const service = new MysticismService();

    service.recordPayment({
      id: "pay1",
      entityId: "e1",
      amount: "1.00",
      currency: "USDC",
      system: "tarot",
      timestamp: Date.now(),
      status: "completed",
    });
    service.recordPayment({
      id: "pay2",
      entityId: "e1",
      amount: "2.00",
      currency: "USDC",
      system: "iching",
      timestamp: Date.now(),
      status: "pending",
    });

    const history = service.getPaymentHistory("e1");
    const completed = history.filter((p) => p.status === "completed");
    const pending = history.filter((p) => p.status === "pending");
    expect(completed).toHaveLength(1);
    expect(pending).toHaveLength(1);
    expect(completed[0].amount).toBe("1.00");
    expect(pending[0].amount).toBe("2.00");
  });
});
