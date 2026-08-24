import { describe, expect, it } from "vitest";
import { PaymentRouter } from "./PaymentRouter.ts";

const defaultRouter = () => new PaymentRouter();

describe("PaymentRouter", () => {
  describe("route()", () => {
    it("routes micropayments + autonomous agents to x402", () => {
      const router = defaultRouter();
      const decision = router.route({
        amount: 50_000, // $0.05
        recipient: "0xabc",
        autonomous: true,
      });
      expect(decision.rail).toBe("x402");
      expect(decision.isLive).toBe(true);
    });

    it("routes larger supervised amounts to MPP", () => {
      const router = defaultRouter();
      const decision = router.route({
        amount: 5_000_000, // $5.00
        recipient: "merchant.example",
      });
      expect(decision.rail).toBe("mpp");
      expect(decision.estimatedOverheadBps).toBe(290);
    });

    it("routes high-frequency session contexts to MPP even for micropayments", () => {
      const router = defaultRouter();
      const decision = router.route({
        amount: 50_000, // $0.05 — below micro threshold
        recipient: "0xabc",
        isSessionContext: true,
        sessionTxCount: 6, // above default highFrequencyThreshold (5)
      });
      expect(decision.rail).toBe("mpp");
      expect(decision.reason).toContain("High-frequency session");
    });

    it("does not route low-frequency sessions to MPP just for session context", () => {
      const router = defaultRouter();
      const decision = router.route({
        amount: 50_000,
        recipient: "0xabc",
        isSessionContext: true,
        sessionTxCount: 2, // below threshold
        autonomous: true,
      });
      expect(decision.rail).toBe("x402");
    });

    it("routes to x402-solana when solana is preferred and rail is live", () => {
      const router = new PaymentRouter({
        rails: [
          { rail: "x402", status: "live" },
          { rail: "mpp", status: "live" },
          { rail: "x402-solana", status: "live" },
          { rail: "google-ap2", status: "planned" },
        ],
      });
      const decision = router.route({
        amount: 5_000_000,
        recipient: "solana-address",
        preferredChain: "solana",
      });
      expect(decision.rail).toBe("x402-solana");
      expect(decision.estimatedOverheadBps).toBe(0);
    });

    it("falls through to other rails when preferred solana rail is not live", () => {
      const router = defaultRouter(); // x402-solana is 'planned'
      const decision = router.route({
        amount: 5_000_000,
        recipient: "solana-address",
        preferredChain: "solana",
      });
      expect(decision.rail).toBe("mpp");
    });

    it("routes to google-ap2 only when it is explicitly live and chain is base", () => {
      const router = new PaymentRouter({
        rails: [
          { rail: "x402", status: "live" },
          { rail: "mpp", status: "live" },
          { rail: "x402-solana", status: "planned" },
          { rail: "google-ap2", status: "live" },
        ],
      });
      const decision = router.route({
        amount: 5_000_000,
        recipient: "merchant.example",
        preferredChain: "base",
      });
      expect(decision.rail).toBe("google-ap2");
    });

    it("does not route to google-ap2 when it is only planned", () => {
      const router = defaultRouter(); // google-ap2 is 'planned'
      const decision = router.route({
        amount: 5_000_000,
        recipient: "merchant.example",
        preferredChain: "base",
      });
      expect(decision.rail).toBe("mpp");
    });

    it("defaults to x402 when no other rule matches", () => {
      const router = new PaymentRouter({
        rails: [
          { rail: "x402", status: "live" },
          { rail: "mpp", status: "disabled" },
          { rail: "x402-solana", status: "planned" },
          { rail: "google-ap2", status: "planned" },
        ],
      });
      const decision = router.route({
        amount: 500_000, // $0.50 — below micro threshold is 1_000_000? no: 500k < 1M yes
        recipient: "0xabc",
        autonomous: false,
      });
      // Not autonomous, not session, mpp disabled → default
      expect(decision.rail).toBe("x402");
      expect(decision.isLive).toBe(true);
    });

    it("marks default-rail decision non-live when x402 is not live", () => {
      const router = new PaymentRouter({
        rails: [
          { rail: "x402", status: "planned" },
          { rail: "mpp", status: "disabled" },
        ],
      });
      const decision = router.route({
        amount: 500_000,
        recipient: "0xabc",
        autonomous: false,
      });
      expect(decision.rail).toBe("x402");
      expect(decision.isLive).toBe(false);
    });

    it("respects microPaymentThreshold boundary exactly", () => {
      const router = defaultRouter(); // threshold 1_000_000
      // amount === threshold → NOT a micropayment (strict <), MPP minAmount is 100_000 so MPP wins
      const decision = router.route({
        amount: 1_000_000, // exactly $1.00
        recipient: "0xabc",
        autonomous: true,
      });
      expect(decision.rail).toBe("mpp");
    });

    it("uses custom microPaymentThreshold", () => {
      const router = new PaymentRouter({ microPaymentThreshold: 5_000_000 });
      const decision = router.route({
        amount: 4_000_000, // $4.00 < $5.00 custom threshold
        recipient: "0xabc",
        autonomous: true,
      });
      expect(decision.rail).toBe("x402");
    });
  });

  describe("getLiveRails()", () => {
    it("returns only live rails", () => {
      const router = defaultRouter();
      const live = router.getLiveRails();
      expect(live.map((r) => r.rail).sort()).toEqual(["mpp", "x402"]);
    });
  });

  describe("isRailLive()", () => {
    it("reports live status per rail", () => {
      const router = defaultRouter();
      expect(router.isRailLive("x402")).toBe(true);
      expect(router.isRailLive("mpp")).toBe(true);
      expect(router.isRailLive("x402-solana")).toBe(false);
      expect(router.isRailLive("google-ap2")).toBe(false);
    });
  });
});
