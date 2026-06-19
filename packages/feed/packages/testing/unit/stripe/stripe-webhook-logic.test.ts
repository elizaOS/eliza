/**
 * Unit Tests: Stripe Webhook Event Logic
 *
 * Tests for the business logic in Stripe webhook event handling.
 * These are pure logic tests that verify event type routing,
 * metadata extraction behavior, and app metadata filtering.
 */

import { describe, expect, it } from "bun:test";
import {
  createChargeRefundedEvent,
  createCheckoutCompletedEvent,
  createCheckoutExpiredEvent,
  createDisputeCreatedEvent,
  createDisputeLostEvent,
  createDisputeWonEvent,
} from "./test-fixtures";

/**
 * Simulated Stripe event types we handle
 */
type StripeEventType =
  | "checkout.session.completed"
  | "checkout.session.expired"
  | "checkout.session.async_payment_succeeded"
  | "checkout.session.async_payment_failed"
  | "charge.dispute.created"
  | "charge.dispute.closed"
  | "charge.refunded";

/**
 * Event routing logic (mirrors webhook handler switch statement)
 */
function getEventAction(eventType: string): string {
  switch (eventType) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded":
      return "fund_trading_balance";
    case "checkout.session.expired":
      return "log_expiry";
    case "checkout.session.async_payment_failed":
      return "log_failure";
    case "charge.dispute.created":
      return "deduct_trading_balance";
    case "charge.dispute.closed":
      return "handle_dispute_resolution";
    case "charge.refunded":
      return "deduct_trading_balance";
    default:
      return "unhandled";
  }
}

/**
 * Determine if event should modify user balance
 */
function shouldModifyBalance(eventType: string): boolean {
  const balanceModifyingEvents = [
    "checkout.session.completed",
    "checkout.session.async_payment_succeeded",
    "charge.dispute.created",
    "charge.dispute.closed",
    "charge.refunded",
  ];
  return balanceModifyingEvents.includes(eventType);
}

/**
 * Extract metadata from checkout session
 */
function extractSessionMetadata(metadata: Record<string, string> | null): {
  userId: string | null;
  balanceUnits: number | null;
  amountUSD: number | null;
} {
  if (!metadata) {
    return { userId: null, balanceUnits: null, amountUSD: null };
  }

  return {
    userId: metadata.userId || null,
    balanceUnits: metadata.balanceUnits
      ? parseInt(metadata.balanceUnits, 10)
      : metadata.pointsAmount
        ? parseInt(metadata.pointsAmount, 10)
        : null,
    amountUSD: metadata.amountUSD ? parseFloat(metadata.amountUSD) : null,
  };
}

describe("Stripe Webhook Event Routing", () => {
  describe("getEventAction", () => {
    describe("Checkout Events", () => {
      it("should route checkout.session.completed to fund_trading_balance", () => {
        expect(getEventAction("checkout.session.completed")).toBe(
          "fund_trading_balance",
        );
      });

      it("should route checkout.session.async_payment_succeeded to fund_trading_balance", () => {
        expect(getEventAction("checkout.session.async_payment_succeeded")).toBe(
          "fund_trading_balance",
        );
      });

      it("should route checkout.session.expired to log_expiry", () => {
        expect(getEventAction("checkout.session.expired")).toBe("log_expiry");
      });

      it("should route checkout.session.async_payment_failed to log_failure", () => {
        expect(getEventAction("checkout.session.async_payment_failed")).toBe(
          "log_failure",
        );
      });
    });

    describe("Dispute Events", () => {
      it("should route charge.dispute.created to deduct_trading_balance", () => {
        expect(getEventAction("charge.dispute.created")).toBe(
          "deduct_trading_balance",
        );
      });

      it("should route charge.dispute.closed to handle_dispute_resolution", () => {
        expect(getEventAction("charge.dispute.closed")).toBe(
          "handle_dispute_resolution",
        );
      });
    });

    describe("Refund Events", () => {
      it("should route charge.refunded to deduct_trading_balance", () => {
        expect(getEventAction("charge.refunded")).toBe(
          "deduct_trading_balance",
        );
      });
    });

    describe("Unhandled Events", () => {
      it("should return unhandled for unknown event types", () => {
        expect(getEventAction("customer.created")).toBe("unhandled");
        expect(getEventAction("invoice.paid")).toBe("unhandled");
        expect(getEventAction("random.event")).toBe("unhandled");
      });
    });
  });

  describe("shouldModifyBalance", () => {
    it("should return true for events that fund trading balance", () => {
      expect(shouldModifyBalance("checkout.session.completed")).toBe(true);
      expect(
        shouldModifyBalance("checkout.session.async_payment_succeeded"),
      ).toBe(true);
    });

    it("should return true for events that deduct trading balance", () => {
      expect(shouldModifyBalance("charge.dispute.created")).toBe(true);
      expect(shouldModifyBalance("charge.refunded")).toBe(true);
    });

    it("should return true for dispute closure (may re-credit)", () => {
      expect(shouldModifyBalance("charge.dispute.closed")).toBe(true);
    });

    it("should return false for logging-only events", () => {
      expect(shouldModifyBalance("checkout.session.expired")).toBe(false);
      expect(shouldModifyBalance("checkout.session.async_payment_failed")).toBe(
        false,
      );
    });

    it("should return false for unhandled events", () => {
      expect(shouldModifyBalance("customer.created")).toBe(false);
      expect(shouldModifyBalance("invoice.paid")).toBe(false);
    });
  });
});

describe("Session Metadata Extraction", () => {
  describe("extractSessionMetadata", () => {
    it("should extract all fields from valid metadata", () => {
      const metadata = {
        userId: "user_123",
        balanceUnits: "5000",
        amountUSD: "50.00",
      };

      const result = extractSessionMetadata(metadata);
      expect(result.userId).toBe("user_123");
      expect(result.balanceUnits).toBe(5000);
      expect(result.amountUSD).toBe(50.0);
    });

    it("should handle null metadata", () => {
      const result = extractSessionMetadata(null);
      expect(result.userId).toBeNull();
      expect(result.balanceUnits).toBeNull();
      expect(result.amountUSD).toBeNull();
    });

    it("should handle empty metadata", () => {
      const result = extractSessionMetadata({});
      expect(result.userId).toBeNull();
      expect(result.balanceUnits).toBeNull();
      expect(result.amountUSD).toBeNull();
    });

    it("should handle partial metadata", () => {
      const metadata = { userId: "user_123" };
      const result = extractSessionMetadata(metadata);
      expect(result.userId).toBe("user_123");
      expect(result.balanceUnits).toBeNull();
      expect(result.amountUSD).toBeNull();
    });

    it("should parse integer balanceUnits correctly", () => {
      const metadata = { balanceUnits: "10000" };
      const result = extractSessionMetadata(metadata);
      expect(result.balanceUnits).toBe(10000);
    });

    it("should accept legacy pointsAmount metadata as fallback", () => {
      const metadata = { pointsAmount: "10000" };
      const result = extractSessionMetadata(metadata);
      expect(result.balanceUnits).toBe(10000);
    });

    it("should parse decimal amountUSD correctly", () => {
      const metadata = { amountUSD: "99.99" };
      const result = extractSessionMetadata(metadata);
      expect(result.amountUSD).toBe(99.99);
    });
  });
});

describe("Dispute Status Handling", () => {
  type DisputeStatus =
    | "won"
    | "lost"
    | "needs_response"
    | "under_review"
    | "warning_needs_response"
    | "warning_under_review"
    | "warning_closed";

  function getDisputeClosureAction(
    status: DisputeStatus,
  ): "recredit" | "log_only" {
    if (status === "won") {
      return "recredit";
    }
    return "log_only";
  }

  it("should re-credit points only when dispute is won", () => {
    expect(getDisputeClosureAction("won")).toBe("recredit");
  });

  it("should only log when dispute is lost", () => {
    expect(getDisputeClosureAction("lost")).toBe("log_only");
  });

  it("should only log for other dispute statuses", () => {
    expect(getDisputeClosureAction("needs_response")).toBe("log_only");
    expect(getDisputeClosureAction("under_review")).toBe("log_only");
    expect(getDisputeClosureAction("warning_needs_response")).toBe("log_only");
    expect(getDisputeClosureAction("warning_under_review")).toBe("log_only");
    expect(getDisputeClosureAction("warning_closed")).toBe("log_only");
  });
});

describe("Refund Amount Handling", () => {
  function calculateRefundPoints(amountCents: number): number {
    const amountUSD = amountCents / 100;
    return Math.floor(amountUSD * 100);
  }

  it("should convert cents to points correctly", () => {
    expect(calculateRefundPoints(5000)).toBe(5000); // $50.00
    expect(calculateRefundPoints(1000)).toBe(1000); // $10.00
    expect(calculateRefundPoints(100)).toBe(100); // $1.00
  });

  it("should handle partial refunds", () => {
    expect(calculateRefundPoints(2500)).toBe(2500); // $25.00
    expect(calculateRefundPoints(1234)).toBe(1234); // $12.34
  });

  it("should floor fractional cents", () => {
    // Stripe amounts are always in cents (integers), so this shouldn't happen
    // but testing defensive behavior
    expect(calculateRefundPoints(99)).toBe(99); // $0.99
    expect(calculateRefundPoints(1)).toBe(1); // $0.01
  });
});

describe("Event Idempotency", () => {
  const processedEvents = new Set<string>();

  function isEventProcessed(eventId: string): boolean {
    return processedEvents.has(eventId);
  }

  function markEventProcessed(eventId: string): void {
    processedEvents.add(eventId);
  }

  function shouldProcessEvent(eventId: string): boolean {
    if (isEventProcessed(eventId)) {
      return false;
    }
    markEventProcessed(eventId);
    return true;
  }

  it("should process event on first encounter", () => {
    const eventId = "evt_test_first";
    expect(shouldProcessEvent(eventId)).toBe(true);
  });

  it("should not process same event twice", () => {
    const eventId = "evt_test_duplicate";
    expect(shouldProcessEvent(eventId)).toBe(true);
    expect(shouldProcessEvent(eventId)).toBe(false);
  });

  it("should process different events independently", () => {
    const eventId1 = "evt_test_a";
    const eventId2 = "evt_test_b";
    expect(shouldProcessEvent(eventId1)).toBe(true);
    expect(shouldProcessEvent(eventId2)).toBe(true);
  });
});

describe("Webhook Response Behavior", () => {
  function getWebhookResponseStatus(
    eventProcessed: boolean,
    _processingSuccessful: boolean | null,
  ): number {
    // Always return 200 for handled events to prevent Stripe retries
    // Even if processing fails, we want to acknowledge receipt
    if (eventProcessed) {
      return 200;
    }
    // For unhandled events, still return 200 (we just log them)
    return 200;
  }

  it("should return 200 for successfully processed events", () => {
    expect(getWebhookResponseStatus(true, true)).toBe(200);
  });

  it("should return 200 even for failed processing (to prevent retries)", () => {
    expect(getWebhookResponseStatus(true, false)).toBe(200);
  });

  it("should return 200 for unhandled events", () => {
    expect(getWebhookResponseStatus(false, null)).toBe(200);
  });
});

describe("Checkout Session Status Validation", () => {
  type SessionStatus = "complete" | "expired" | "open";
  type PaymentStatus = "paid" | "unpaid" | "no_payment_required";

  function shouldCreditPoints(
    sessionStatus: SessionStatus,
    paymentStatus: PaymentStatus,
  ): boolean {
    return sessionStatus === "complete" && paymentStatus === "paid";
  }

  it("should credit points when session complete and payment paid", () => {
    expect(shouldCreditPoints("complete", "paid")).toBe(true);
  });

  it("should not credit points when session not complete", () => {
    expect(shouldCreditPoints("expired", "paid")).toBe(false);
    expect(shouldCreditPoints("open", "paid")).toBe(false);
  });

  it("should not credit points when payment not paid", () => {
    expect(shouldCreditPoints("complete", "unpaid")).toBe(false);
    expect(shouldCreditPoints("complete", "no_payment_required")).toBe(false);
  });
});

describe("App Metadata Filtering", () => {
  /**
   * Extract app metadata from a Stripe event object.
   * Mirrors the logic in the webhook handler that checks
   * event.data.object.metadata.app and falls back to
   * event.data.object.subscription_details.metadata.app.
   */
  function extractAppMetadata(
    eventObject: Record<string, unknown>,
  ): string | undefined {
    return (
      (eventObject?.metadata as Record<string, string> | undefined)?.app ??
      (
        (
          eventObject?.subscription_details as
            | Record<string, unknown>
            | undefined
        )?.metadata as Record<string, string> | undefined
      )?.app
    );
  }

  /**
   * Determine if an event should be processed by this app.
   * Returns true if the event belongs to 'feed' or has no app tag (backward compat).
   */
  function shouldProcessForApp(
    eventObject: Record<string, unknown>,
    appName: string = "feed",
  ): boolean {
    const app = extractAppMetadata(eventObject);
    // If no app metadata, allow (backward compat with pre-tagging resources)
    if (!app) return true;
    // Only process if it matches our app
    return app === appName;
  }

  describe("extractAppMetadata", () => {
    it("should extract app from top-level metadata", () => {
      const obj = { metadata: { app: "feed" } };
      expect(extractAppMetadata(obj)).toBe("feed");
    });

    it("should extract app from subscription_details.metadata", () => {
      const obj = {
        metadata: {},
        subscription_details: { metadata: { app: "eliza-cloud" } },
      };
      expect(extractAppMetadata(obj)).toBe("eliza-cloud");
    });

    it("should prefer top-level metadata over subscription_details", () => {
      const obj = {
        metadata: { app: "feed" },
        subscription_details: { metadata: { app: "eliza-cloud" } },
      };
      expect(extractAppMetadata(obj)).toBe("feed");
    });

    it("should return undefined when no app metadata exists", () => {
      const obj = { metadata: {} };
      expect(extractAppMetadata(obj)).toBeUndefined();
    });

    it("should return undefined when metadata is absent", () => {
      const obj = {};
      expect(extractAppMetadata(obj)).toBeUndefined();
    });

    it("should return undefined when metadata is null-ish", () => {
      const obj = { metadata: null };
      expect(
        extractAppMetadata(obj as Record<string, unknown>),
      ).toBeUndefined();
    });
  });

  describe("shouldProcessForApp", () => {
    it("should process events tagged with feed", () => {
      const obj = { metadata: { app: "feed" } };
      expect(shouldProcessForApp(obj)).toBe(true);
    });

    it("should reject events tagged with eliza-cloud", () => {
      const obj = { metadata: { app: "eliza-cloud" } };
      expect(shouldProcessForApp(obj)).toBe(false);
    });

    it("should reject events tagged with unknown app", () => {
      const obj = { metadata: { app: "some-other-app" } };
      expect(shouldProcessForApp(obj)).toBe(false);
    });

    it("should allow events with no app metadata (backward compat)", () => {
      const obj = { metadata: {} };
      expect(shouldProcessForApp(obj)).toBe(true);
    });

    it("should allow events with no metadata at all (backward compat)", () => {
      const obj = {};
      expect(shouldProcessForApp(obj)).toBe(true);
    });

    it("should process when subscription_details has feed", () => {
      const obj = {
        metadata: {},
        subscription_details: { metadata: { app: "feed" } },
      };
      expect(shouldProcessForApp(obj)).toBe(true);
    });

    it("should reject when subscription_details has eliza-cloud", () => {
      const obj = {
        metadata: {},
        subscription_details: { metadata: { app: "eliza-cloud" } },
      };
      expect(shouldProcessForApp(obj)).toBe(false);
    });
  });

  describe("Filtering across all webhook event types", () => {
    describe("checkout.session.completed", () => {
      it("should process feed-tagged event", () => {
        const event = createCheckoutCompletedEvent("user_1", 10, {
          app: "feed",
        });
        expect(
          shouldProcessForApp(
            event.data.object as unknown as Record<string, unknown>,
          ),
        ).toBe(true);
      });

      it("should reject eliza-cloud-tagged event", () => {
        const event = createCheckoutCompletedEvent("user_1", 10, {
          app: "eliza-cloud",
        });
        expect(
          shouldProcessForApp(
            event.data.object as unknown as Record<string, unknown>,
          ),
        ).toBe(false);
      });

      it("should allow event with no app tag (backward compat)", () => {
        const event = createCheckoutCompletedEvent("user_1", 10);
        // Remove app from metadata to simulate legacy event
        delete (
          event.data.object as unknown as Record<string, unknown> & {
            metadata: Record<string, string | undefined>;
          }
        ).metadata.app;
        expect(
          shouldProcessForApp(
            event.data.object as unknown as Record<string, unknown>,
          ),
        ).toBe(true);
      });
    });

    describe("checkout.session.expired", () => {
      it("should process feed-tagged event", () => {
        const event = createCheckoutExpiredEvent(undefined, undefined, {
          app: "feed",
        });
        expect(
          shouldProcessForApp(
            event.data.object as unknown as Record<string, unknown>,
          ),
        ).toBe(true);
      });

      it("should reject eliza-cloud-tagged event", () => {
        const event = createCheckoutExpiredEvent(undefined, undefined, {
          app: "eliza-cloud",
        });
        expect(
          shouldProcessForApp(
            event.data.object as unknown as Record<string, unknown>,
          ),
        ).toBe(false);
      });
    });

    describe("checkout.session.async_payment_succeeded", () => {
      it("should process feed-tagged event", () => {
        const event = createCheckoutCompletedEvent("user_1", 10, {
          app: "feed",
        });
        event.type = "checkout.session.async_payment_succeeded";
        expect(
          shouldProcessForApp(
            event.data.object as unknown as Record<string, unknown>,
          ),
        ).toBe(true);
      });

      it("should reject eliza-cloud-tagged event", () => {
        const event = createCheckoutCompletedEvent("user_1", 10, {
          app: "eliza-cloud",
        });
        event.type = "checkout.session.async_payment_succeeded";
        expect(
          shouldProcessForApp(
            event.data.object as unknown as Record<string, unknown>,
          ),
        ).toBe(false);
      });
    });

    describe("checkout.session.async_payment_failed", () => {
      it("should process feed-tagged event", () => {
        const event = createCheckoutCompletedEvent("user_1", 10, {
          app: "feed",
        });
        event.type = "checkout.session.async_payment_failed";
        expect(
          shouldProcessForApp(
            event.data.object as unknown as Record<string, unknown>,
          ),
        ).toBe(true);
      });

      it("should reject eliza-cloud-tagged event", () => {
        const event = createCheckoutCompletedEvent("user_1", 10, {
          app: "eliza-cloud",
        });
        event.type = "checkout.session.async_payment_failed";
        expect(
          shouldProcessForApp(
            event.data.object as unknown as Record<string, unknown>,
          ),
        ).toBe(false);
      });
    });

    describe("charge.dispute.created", () => {
      it("should process feed-tagged event", () => {
        const event = createDisputeCreatedEvent("pi_test", 50, {
          app: "feed",
        });
        expect(
          shouldProcessForApp(
            event.data.object as unknown as Record<string, unknown>,
          ),
        ).toBe(true);
      });

      it("should reject eliza-cloud-tagged event", () => {
        const event = createDisputeCreatedEvent("pi_test", 50, {
          app: "eliza-cloud",
        });
        expect(
          shouldProcessForApp(
            event.data.object as unknown as Record<string, unknown>,
          ),
        ).toBe(false);
      });
    });

    describe("charge.dispute.closed (won)", () => {
      it("should process feed-tagged event", () => {
        const event = createDisputeWonEvent("pi_test", 50, {
          app: "feed",
        });
        expect(
          shouldProcessForApp(
            event.data.object as unknown as Record<string, unknown>,
          ),
        ).toBe(true);
      });

      it("should reject eliza-cloud-tagged event", () => {
        const event = createDisputeWonEvent("pi_test", 50, {
          app: "eliza-cloud",
        });
        expect(
          shouldProcessForApp(
            event.data.object as unknown as Record<string, unknown>,
          ),
        ).toBe(false);
      });
    });

    describe("charge.dispute.closed (lost)", () => {
      it("should process feed-tagged event", () => {
        const event = createDisputeLostEvent("pi_test", 50, {
          app: "feed",
        });
        expect(
          shouldProcessForApp(
            event.data.object as unknown as Record<string, unknown>,
          ),
        ).toBe(true);
      });

      it("should reject eliza-cloud-tagged event", () => {
        const event = createDisputeLostEvent("pi_test", 50, {
          app: "eliza-cloud",
        });
        expect(
          shouldProcessForApp(
            event.data.object as unknown as Record<string, unknown>,
          ),
        ).toBe(false);
      });
    });

    describe("charge.refunded", () => {
      it("should process feed-tagged event", () => {
        const event = createChargeRefundedEvent("pi_test", 25, 50, {
          app: "feed",
        });
        expect(
          shouldProcessForApp(
            event.data.object as unknown as Record<string, unknown>,
          ),
        ).toBe(true);
      });

      it("should reject eliza-cloud-tagged event", () => {
        const event = createChargeRefundedEvent("pi_test", 25, 50, {
          app: "eliza-cloud",
        });
        expect(
          shouldProcessForApp(
            event.data.object as unknown as Record<string, unknown>,
          ),
        ).toBe(false);
      });
    });
  });

  describe("Response behavior for filtered events", () => {
    it("should return 200 for filtered events (prevent Stripe retries)", () => {
      // When an event is filtered, we return 200 so Stripe doesn't retry
      const filteredResponse = {
        status: 200,
        body: { received: true, ignored: true },
      };
      expect(filteredResponse.status).toBe(200);
      expect(filteredResponse.body.ignored).toBe(true);
    });

    it("should return 200 for processed events", () => {
      const processedResponse = { status: 200, body: { received: true } };
      expect(processedResponse.status).toBe(200);
    });
  });
});

describe("Events to Configure in Stripe Dashboard", () => {
  const requiredEvents: StripeEventType[] = [
    "checkout.session.completed",
    "checkout.session.expired",
    "checkout.session.async_payment_succeeded",
    "checkout.session.async_payment_failed",
    "charge.dispute.created",
    "charge.dispute.closed",
    "charge.refunded",
  ];

  it("should have all required events defined", () => {
    expect(requiredEvents.length).toBe(7);
  });

  it("should include all checkout session events", () => {
    const checkoutEvents = requiredEvents.filter((e) =>
      e.startsWith("checkout.session"),
    );
    expect(checkoutEvents.length).toBe(4);
  });

  it("should include all dispute events", () => {
    const disputeEvents = requiredEvents.filter((e) =>
      e.startsWith("charge.dispute"),
    );
    expect(disputeEvents.length).toBe(2);
  });

  it("should include refund event", () => {
    expect(requiredEvents).toContain("charge.refunded");
  });
});
