import { beforeEach, describe, expect, it } from "vitest";
import { MysticismService } from "../../src/services/mysticism-service";

const ENTITY_A = "entity-aaa-111";
const ROOM_1 = "room-111";

describe("Payment Tracking", () => {
  let service: MysticismService;

  beforeEach(() => {
    service = new MysticismService();
  });

  it("paymentStatus starts as none", () => {
    const session = service.startTarotReading(ENTITY_A, ROOM_1, "single", "Quick question");
    expect(session.paymentStatus).toBe("none");
    expect(session.paymentAmount).toBeNull();
    expect(session.paymentTxHash).toBeNull();
  });

  it("markPaymentRequested sets status and amount", () => {
    service.startTarotReading(ENTITY_A, ROOM_1, "single", "Quick question");

    service.markPaymentRequested(ENTITY_A, ROOM_1, "0.01");

    const session = service.getSession(ENTITY_A, ROOM_1);
    expect(session).not.toBeNull();
    expect(session?.paymentStatus).toBe("requested");
    expect(session?.paymentAmount).toBe("0.01");
    expect(session?.paymentTxHash).toBeNull();
  });

  it("recordConversationPayment sets paid status with txHash", () => {
    service.startTarotReading(ENTITY_A, ROOM_1, "single", "Quick question");

    service.recordConversationPayment(ENTITY_A, ROOM_1, "0.01", "tx_abc123");

    const session = service.getSession(ENTITY_A, ROOM_1);
    expect(session).not.toBeNull();
    expect(session?.paymentStatus).toBe("paid");
    expect(session?.paymentAmount).toBe("0.01");
    expect(session?.paymentTxHash).toBe("tx_abc123");
  });

  it("payment status is visible in getSession", () => {
    service.startTarotReading(ENTITY_A, ROOM_1, "single", "Quick question");

    // Initially none
    let session = service.getSession(ENTITY_A, ROOM_1);
    expect(session?.paymentStatus).toBe("none");

    // After requesting
    service.markPaymentRequested(ENTITY_A, ROOM_1, "0.02");
    session = service.getSession(ENTITY_A, ROOM_1);
    expect(session?.paymentStatus).toBe("requested");
    expect(session?.paymentAmount).toBe("0.02");

    // After paying
    service.recordConversationPayment(ENTITY_A, ROOM_1, "0.02", "tx_def456");
    session = service.getSession(ENTITY_A, ROOM_1);
    expect(session?.paymentStatus).toBe("paid");
    expect(session?.paymentAmount).toBe("0.02");
    expect(session?.paymentTxHash).toBe("tx_def456");
  });

  it("markPaymentRequested then recordConversationPayment transitions correctly", () => {
    service.startTarotReading(ENTITY_A, ROOM_1, "three_card", "What lies ahead?");

    // Step 1: request payment
    service.markPaymentRequested(ENTITY_A, ROOM_1, "0.01");
    let session = service.getSession(ENTITY_A, ROOM_1);
    expect(session?.paymentStatus).toBe("requested");
    expect(session?.paymentAmount).toBe("0.01");
    expect(session?.paymentTxHash).toBeNull();

    // Step 2: record payment
    service.recordConversationPayment(ENTITY_A, ROOM_1, "0.01", "tx_final789");
    session = service.getSession(ENTITY_A, ROOM_1);
    expect(session?.paymentStatus).toBe("paid");
    expect(session?.paymentAmount).toBe("0.01");
    expect(session?.paymentTxHash).toBe("tx_final789");
  });
});
