/**
 * Stripe Test Fixtures
 *
 * Mock data and utility functions for testing Stripe integration.
 * These fixtures simulate Stripe API responses and webhook events.
 */

/**
 * Mock Stripe Checkout Session
 */
export interface MockCheckoutSession {
  id: string;
  object: 'checkout.session';
  payment_status: 'paid' | 'unpaid' | 'no_payment_required';
  status: 'complete' | 'expired' | 'open';
  payment_intent: string | null;
  amount_total: number;
  currency: string;
  metadata: {
    app?: string;
    userId: string;
    balanceUnits: string;
    amountUSD: string;
    purchaseType?: string;
  };
}

/**
 * Mock Stripe Dispute
 */
export interface MockDispute {
  id: string;
  object: 'dispute';
  amount: number;
  currency: string;
  status:
    | 'won'
    | 'lost'
    | 'needs_response'
    | 'under_review'
    | 'warning_needs_response'
    | 'warning_under_review'
    | 'warning_closed';
  payment_intent: string;
  charge: string;
  metadata: Record<string, string>;
}

/**
 * Mock Stripe Charge
 */
export interface MockCharge {
  id: string;
  object: 'charge';
  amount: number;
  amount_refunded: number;
  currency: string;
  payment_intent: string;
  refunded: boolean;
  metadata: Record<string, string>;
}

/**
 * Mock Stripe Event
 */
export interface MockStripeEvent<T = unknown> {
  id: string;
  object: 'event';
  type: string;
  created: number;
  data: {
    object: T;
  };
}

/**
 * Create a mock checkout session completed event
 */
export function createCheckoutCompletedEvent(
  userId: string,
  amountUSD: number,
  options: {
    sessionId?: string;
    paymentIntentId?: string;
    eventId?: string;
    app?: string;
  } = {}
): MockStripeEvent<MockCheckoutSession> {
  const balanceUnits = Math.floor(amountUSD * 100);
  const sessionId = options.sessionId ?? `cs_test_${Date.now()}`;
  const paymentIntentId = options.paymentIntentId ?? `pi_test_${Date.now()}`;
  const eventId = options.eventId ?? `evt_test_${Date.now()}`;

  return {
    id: eventId,
    object: 'event',
    type: 'checkout.session.completed',
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: sessionId,
        object: 'checkout.session',
        payment_status: 'paid',
        status: 'complete',
        payment_intent: paymentIntentId,
        amount_total: amountUSD * 100, // cents
        currency: 'usd',
        metadata: {
          ...(options.app !== undefined
            ? { app: options.app }
            : { app: 'feed' }),
          userId,
          balanceUnits: balanceUnits.toString(),
          amountUSD: amountUSD.toString(),
          purchaseType: 'trading_balance',
        },
      },
    },
  };
}

/**
 * Create a mock checkout session expired event
 */
export function createCheckoutExpiredEvent(
  sessionId?: string,
  eventId?: string,
  options: { app?: string } = {}
): MockStripeEvent<MockCheckoutSession> {
  return {
    id: eventId ?? `evt_test_${Date.now()}`,
    object: 'event',
    type: 'checkout.session.expired',
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: sessionId ?? `cs_test_${Date.now()}`,
        object: 'checkout.session',
        payment_status: 'unpaid',
        status: 'expired',
        payment_intent: null,
        amount_total: 0,
        currency: 'usd',
        metadata: {
          ...(options.app !== undefined
            ? { app: options.app }
            : { app: 'feed' }),
          userId: '',
          balanceUnits: '',
          amountUSD: '',
          purchaseType: 'trading_balance',
        },
      },
    },
  };
}

/**
 * Create a mock dispute created event
 */
export function createDisputeCreatedEvent(
  paymentIntentId: string,
  amountUSD: number,
  options: {
    disputeId?: string;
    chargeId?: string;
    eventId?: string;
    app?: string;
  } = {}
): MockStripeEvent<MockDispute> {
  const disputeId = options.disputeId ?? `dp_test_${Date.now()}`;
  const chargeId = options.chargeId ?? `ch_test_${Date.now()}`;
  const eventId = options.eventId ?? `evt_test_${Date.now()}`;

  return {
    id: eventId,
    object: 'event',
    type: 'charge.dispute.created',
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: disputeId,
        object: 'dispute',
        amount: amountUSD * 100, // cents
        currency: 'usd',
        status: 'needs_response',
        payment_intent: paymentIntentId,
        charge: chargeId,
        metadata:
          options.app !== undefined ? { app: options.app } : { app: 'feed' },
      },
    },
  };
}

/**
 * Create a mock dispute closed event (won)
 */
export function createDisputeWonEvent(
  paymentIntentId: string,
  amountUSD: number,
  options: {
    disputeId?: string;
    chargeId?: string;
    eventId?: string;
    app?: string;
  } = {}
): MockStripeEvent<MockDispute> {
  const disputeId = options.disputeId ?? `dp_test_${Date.now()}`;
  const chargeId = options.chargeId ?? `ch_test_${Date.now()}`;
  const eventId = options.eventId ?? `evt_test_${Date.now()}`;

  return {
    id: eventId,
    object: 'event',
    type: 'charge.dispute.closed',
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: disputeId,
        object: 'dispute',
        amount: amountUSD * 100, // cents
        currency: 'usd',
        status: 'won',
        payment_intent: paymentIntentId,
        charge: chargeId,
        metadata:
          options.app !== undefined ? { app: options.app } : { app: 'feed' },
      },
    },
  };
}

/**
 * Create a mock dispute closed event (lost)
 */
export function createDisputeLostEvent(
  paymentIntentId: string,
  amountUSD: number,
  options: {
    disputeId?: string;
    chargeId?: string;
    eventId?: string;
    app?: string;
  } = {}
): MockStripeEvent<MockDispute> {
  const event = createDisputeWonEvent(paymentIntentId, amountUSD, options);
  event.type = 'charge.dispute.closed';
  (event.data.object as MockDispute).status = 'lost';
  return event;
}

/**
 * Create a mock charge refunded event
 */
export function createChargeRefundedEvent(
  paymentIntentId: string,
  amountRefundedUSD: number,
  originalAmountUSD: number,
  options: {
    chargeId?: string;
    eventId?: string;
    app?: string;
  } = {}
): MockStripeEvent<MockCharge> {
  const chargeId = options.chargeId ?? `ch_test_${Date.now()}`;
  const eventId = options.eventId ?? `evt_test_${Date.now()}`;

  return {
    id: eventId,
    object: 'event',
    type: 'charge.refunded',
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: chargeId,
        object: 'charge',
        amount: originalAmountUSD * 100, // cents
        amount_refunded: amountRefundedUSD * 100, // cents
        currency: 'usd',
        payment_intent: paymentIntentId,
        refunded: amountRefundedUSD === originalAmountUSD,
        metadata:
          options.app !== undefined ? { app: options.app } : { app: 'feed' },
      },
    },
  };
}

/**
 * Test user fixture
 */
export interface TestUser {
  id: string;
  username: string;
  virtualBalance: number;
}

/**
 * Create a test user fixture
 */
export function createTestUser(id?: string, initialBalance = 0): TestUser {
  return {
    id: id ?? `test-user-${Date.now()}`,
    username: `testuser_${Date.now()}`,
    virtualBalance: initialBalance,
  };
}

/**
 * Expected points for a given USD amount
 */
export function expectedPoints(amountUSD: number): number {
  return Math.floor(amountUSD * 100);
}

/**
 * Common test scenarios
 */
export const TestScenarios = {
  /**
   * Simple $10 purchase
   */
  simplePurchase: {
    amountUSD: 10,
    expectedPoints: 1000,
  },

  /**
   * Minimum purchase ($1)
   */
  minimumPurchase: {
    amountUSD: 1,
    expectedPoints: 100,
  },

  /**
   * Maximum purchase ($1000)
   */
  maximumPurchase: {
    amountUSD: 1000,
    expectedPoints: 100000,
  },

  /**
   * Purchase then full refund
   */
  fullRefund: {
    purchaseAmountUSD: 50,
    refundAmountUSD: 50,
    expectedPointsAfter: 0,
  },

  /**
   * Purchase then partial refund
   */
  partialRefund: {
    purchaseAmountUSD: 100,
    refundAmountUSD: 30,
    expectedPointsAfter: 7000, // 10000 - 3000
  },

  /**
   * Purchase, dispute created, dispute won
   */
  disputeWon: {
    purchaseAmountUSD: 50,
    // After dispute created: 0 points
    // After dispute won: 5000 points restored
    expectedPointsAfterDispute: 0,
    expectedPointsAfterWin: 5000,
  },

  /**
   * Purchase, spend some, then refund (floored at 0)
   */
  refundAfterSpending: {
    purchaseAmountUSD: 50,
    pointsSpent: 4000,
    refundAmountUSD: 50,
    // Had 5000, spent 4000 = 1000 remaining
    // Refund wants to deduct 5000, but only 1000 available
    // Balance floored at 0
    expectedPointsAfter: 0,
  },
} as const;
