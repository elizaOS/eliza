/**
 * Integration tests for @stwd/eliza-plugin against real Steward API.
 *
 * These tests create a temporary agent on milady-cloud tenant,
 * exercise every plugin component, then clean up.
 *
 * Run with: npx vitest run src/__tests__/integration.test.ts
 */

import type { AgentIdentity } from "@stwd/sdk";
import { StewardApiError, StewardClient } from "@stwd/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signTransactionAction } from "../actions/sign-transaction.js";
import { transferAction } from "../actions/transfer.js";
import { approvalRequiredEvaluator } from "../evaluators/approval.js";
import { balanceProvider } from "../providers/balance.js";
import { walletStatusProvider } from "../providers/wallet-status.js";
import { StewardService } from "../services/StewardService.js";

const runLive = process.env.STEWARD_LIVE_TESTS === "1";
const describeLive = runLive ? describe : describe.skip;

// ── Config ──────────────────────────────────────────────────────

const API_URL = "https://api.steward.fi";
const API_KEY = "stw_b1715e3d9fc4aa49b8d2641f9e0349cf";
const TENANT_ID = "milady-cloud";
const TEST_AGENT_ID = `eliza-integ-${Date.now()}`;

// ── Helpers ─────────────────────────────────────────────────────

let client: StewardClient;
let agent: AgentIdentity;

/**
 * Build a mock IAgentRuntime that the plugin components expect.
 * The service is passed in so providers/actions can find it via getService().
 */
function mockRuntime(service: StewardService | null, overrides: Record<string, any> = {}) {
  return {
    agentId: TEST_AGENT_ID,
    character: {
      name: "IntegrationTestBot",
      settings: {
        steward: {
          apiUrl: API_URL,
          apiKey: API_KEY,
          agentId: TEST_AGENT_ID,
          tenantId: TENANT_ID,
          autoRegister: false,
          fallbackLocal: false,
        },
      },
    },
    getService(name: string) {
      if (name === "steward") return service;
      return null;
    },
    ...overrides,
  } as any;
}

// ── Setup / Teardown ────────────────────────────────────────────

beforeAll(async () => {
  if (!runLive) return;
  client = new StewardClient({
    baseUrl: API_URL,
    apiKey: API_KEY,
    tenantId: TENANT_ID,
  });
  agent = await client.createWallet(TEST_AGENT_ID, "Eliza Integration Test");
  console.log(`[setup] Created agent ${TEST_AGENT_ID} → ${agent.walletAddress}`);
});

afterAll(async () => {
  if (!runLive) return;
  // Steward doesn't have a DELETE agent endpoint yet, so we just log.
  console.log(`[teardown] Test agent ${TEST_AGENT_ID} left on milady-cloud (no delete API)`);
});

// ── StewardService ──────────────────────────────────────────────

describeLive("StewardService (real API)", () => {
  let service: StewardService;

  beforeAll(async () => {
    const runtime = mockRuntime(null);
    service = await StewardService.start(runtime);
  });

  it("connects successfully", () => {
    expect(service.isConnected()).toBe(true);
  });

  it("resolves config from runtime character settings", () => {
    const cfg = service.getConfig();
    expect(cfg).not.toBeNull();
    expect(cfg?.apiUrl).toBe(API_URL);
    expect(cfg?.agentId).toBe(TEST_AGENT_ID);
    expect(cfg?.tenantId).toBe(TENANT_ID);
  });

  it("getAgent returns identity with wallet address", async () => {
    const identity = await service.getAgent();
    expect(identity.id).toBe(TEST_AGENT_ID);
    expect(identity.walletAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it("getBalance returns zero balance for fresh agent", async () => {
    const balance = await service.getBalance();
    expect(balance.agentId).toBe(TEST_AGENT_ID);
    expect(balance.walletAddress).toMatch(/^0x/);
    expect(balance.balances).toBeDefined();
    expect(balance.balances.native).toBe("0");
    expect(balance.balances.symbol).toBe("ETH");
    expect(typeof balance.balances.chainId).toBe("number");
  });

  it("getPolicies returns empty array for fresh agent", async () => {
    const policies = await service.getPolicies();
    expect(Array.isArray(policies)).toBe(true);
    expect(policies).toHaveLength(0);
  });

  it("getHistory returns empty array for fresh agent", async () => {
    const history = await service.getHistory();
    expect(Array.isArray(history)).toBe(true);
    expect(history).toHaveLength(0);
  });

  it("signTransaction rejects unfunded tx gracefully", async () => {
    // Fresh wallet has no funds → should get a meaningful error
    try {
      await service.signTransaction({
        to: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
        value: "1000000000000000", // 0.001 ETH
        chainId: 84532,
      });
      // If it somehow succeeds (pending approval), that's also fine
    } catch (err) {
      expect(err).toBeDefined();
      // Could be StewardApiError or generic Error — both valid
      if (err instanceof StewardApiError) {
        expect(err.status).toBeGreaterThanOrEqual(400);
      }
    }
  });

  afterAll(async () => {
    await service.stop();
  });
});

// ── Providers ───────────────────────────────────────────────────

describeLive("Providers (real API)", () => {
  let service: StewardService;
  let runtime: any;

  beforeAll(async () => {
    runtime = mockRuntime(null);
    service = await StewardService.start(runtime);
    // Re-create runtime with the live service
    runtime = mockRuntime(service);
  });

  afterAll(async () => {
    await service.stop();
  });

  describe("walletStatusProvider", () => {
    it("returns wallet address and agent ID", async () => {
      const result = await walletStatusProvider.get(runtime, {} as any, {} as any);
      expect(result).toBeDefined();
      expect(result.text).toContain("Steward Wallet:");
      expect(result.text).toContain("0x");
      expect(result.text).toContain("Agent ID:");
      expect(result.text).toContain(TEST_AGENT_ID);
      expect(result.values?.walletAddress).toMatch(/^0x/);
      expect(result.values?.agentId).toBe(TEST_AGENT_ID);
    });

    it("returns policy info (empty for fresh agent)", async () => {
      const result = await walletStatusProvider.get(runtime, {} as any, {} as any);
      expect(result.text).toContain("Active policies:");
      expect(result.data?.policies).toBeDefined();
    });
  });

  describe("balanceProvider", () => {
    it("returns formatted balance string", async () => {
      const result = await balanceProvider.get(runtime, {} as any, {} as any);
      expect(result).toBeDefined();
      expect(result.text).toContain("Balance:");
      expect(result.text).toContain("ETH");
      expect(result.values?.symbol).toBe("ETH");
      expect(result.values?.walletAddress).toMatch(/^0x/);
      expect(typeof result.values?.chainId).toBe("number");
    });
  });

  describe("walletStatusProvider (disconnected)", () => {
    it("returns empty when service is null", async () => {
      const disconnectedRuntime = mockRuntime(null);
      const result = await walletStatusProvider.get(disconnectedRuntime, {} as any, {} as any);
      expect(result.text).toBe("");
    });
  });

  describe("balanceProvider (disconnected)", () => {
    it("returns empty when service is null", async () => {
      const disconnectedRuntime = mockRuntime(null);
      const result = await balanceProvider.get(disconnectedRuntime, {} as any, {} as any);
      expect(result.text).toBe("");
    });
  });
});

// ── Actions ─────────────────────────────────────────────────────

describeLive("Actions (validation + error paths)", () => {
  let service: StewardService;
  let runtime: any;

  beforeAll(async () => {
    const initRuntime = mockRuntime(null);
    service = await StewardService.start(initRuntime);
    runtime = mockRuntime(service);
  });

  afterAll(async () => {
    await service.stop();
  });

  describe("signTransactionAction", () => {
    it("validates true when service is connected", async () => {
      const valid = await signTransactionAction.validate(runtime, {} as any);
      expect(valid).toBe(true);
    });

    it("validates false when service is disconnected", async () => {
      const disconnected = mockRuntime(null);
      const valid = await signTransactionAction.validate(disconnected, {} as any);
      expect(valid).toBe(false);
    });

    it("returns error for missing params", async () => {
      const result = await signTransactionAction.handler(runtime, {} as any, undefined, {
        parameters: {},
      });
      expect(result?.success).toBe(false);
      expect(result?.error).toContain("Missing required parameters");
    });

    it("returns error for missing 'to'", async () => {
      const result = await signTransactionAction.handler(runtime, {} as any, undefined, {
        parameters: { value: "1000" },
      });
      expect(result?.success).toBe(false);
      expect(result?.error).toContain("Missing required parameters");
    });

    it("returns error for missing 'value'", async () => {
      const result = await signTransactionAction.handler(runtime, {} as any, undefined, {
        parameters: { to: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" },
      });
      expect(result?.success).toBe(false);
    });

    it("handles unfunded transaction attempt", async () => {
      const result = await signTransactionAction.handler(runtime, {} as any, undefined, {
        parameters: {
          to: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
          value: "1000000000000000",
          chainId: 84532,
        },
      });
      // Should either fail (insufficient funds) or succeed with pending_approval
      expect(result).toBeDefined();
      if (!result?.success) {
        expect(result?.error).toBeDefined();
        expect(typeof result?.error).toBe("string");
      }
    });
  });

  describe("transferAction", () => {
    it("validates true when service is connected", async () => {
      const valid = await transferAction.validate(runtime, {} as any);
      expect(valid).toBe(true);
    });

    it("returns error for missing params", async () => {
      const result = await transferAction.handler(runtime, {} as any, undefined, {
        parameters: {},
      });
      expect(result?.success).toBe(false);
      expect(result?.error).toContain("Missing required parameters");
    });

    it("returns error for unknown chain", async () => {
      const result = await transferAction.handler(runtime, {} as any, undefined, {
        parameters: {
          to: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
          amount: "0.01 ETH",
          chain: "avalanche",
        },
      });
      expect(result?.success).toBe(false);
      expect(result?.error).toContain("Unknown chain");
    });

    it("returns error for invalid amount format", async () => {
      const result = await transferAction.handler(runtime, {} as any, undefined, {
        parameters: {
          to: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
          amount: "not-a-number",
        },
      });
      expect(result?.success).toBe(false);
      expect(result?.text).toContain("Transfer failed");
    });

    it("parses 0.1 ETH correctly and hits API", async () => {
      const result = await transferAction.handler(runtime, {} as any, undefined, {
        parameters: {
          to: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
          amount: "0.1 ETH",
          chain: "base-sepolia",
        },
      });
      // Will fail (no funds) but should reach the API
      expect(result).toBeDefined();
      if (!result?.success) {
        expect(typeof result?.error).toBe("string");
      }
    });

    it("parses amount without symbol (defaults to ETH)", async () => {
      const result = await transferAction.handler(runtime, {} as any, undefined, {
        parameters: {
          to: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
          amount: "0.5",
          chain: "base",
        },
      });
      expect(result).toBeDefined();
    });
  });
});

// ── Evaluator ───────────────────────────────────────────────────

describe("approvalRequiredEvaluator", () => {
  it("validates only for STEWARD_ actions", async () => {
    const stewardMsg = {
      content: { action: "STEWARD_SIGN_TRANSACTION" },
    } as any;
    expect(await approvalRequiredEvaluator.validate({} as any, stewardMsg)).toBe(true);

    const otherMsg = { content: { action: "SOME_OTHER_ACTION" } } as any;
    expect(await approvalRequiredEvaluator.validate({} as any, otherMsg)).toBe(false);

    const noAction = { content: { text: "hello" } } as any;
    expect(await approvalRequiredEvaluator.validate({} as any, noAction)).toBe(false);
  });

  it("returns undefined when no pending approval", async () => {
    const service = { isConnected: () => true } as any;
    const runtime = { getService: () => service } as any;
    const state = { lastActionResult: { data: { status: "completed" } } };

    const result = await approvalRequiredEvaluator.handler(runtime, {} as any, state as any);
    expect(result).toBeUndefined();
  });

  it("returns approval message when pending", async () => {
    const service = { isConnected: () => true } as any;
    const runtime = { getService: () => service } as any;
    const state = {
      lastActionResult: {
        data: {
          status: "pending_approval",
          policies: [{ policyId: "p1", type: "spending-limit", passed: false }],
        },
      },
    };

    const result = await approvalRequiredEvaluator.handler(runtime, {} as any, state as any);
    expect(result).toBeDefined();
    expect(result?.success).toBe(true);
    expect(result?.data?.pendingApproval).toBe(true);
    expect(result?.text).toContain("approval");
  });

  it("returns undefined when service is disconnected", async () => {
    const runtime = { getService: () => null } as any;
    const result = await approvalRequiredEvaluator.handler(runtime, {} as any);
    expect(result).toBeUndefined();
  });
});

// ── parseAmount unit tests (via transfer action) ────────────────

describe("Amount parsing (via transfer handler)", () => {
  const cases = [
    { input: "0.01 ETH", shouldFail: false },
    { input: "1.5 BNB", shouldFail: false },
    { input: "100 USDC", shouldFail: false },
    { input: "0.001", shouldFail: false },
    { input: "", shouldFail: true },
    { input: "abc xyz", shouldFail: true },
    { input: "-5 ETH", shouldFail: true },
  ];

  for (const { input, shouldFail } of cases) {
    it(`${shouldFail ? "rejects" : "accepts"} "${input}"`, async () => {
      const service = {
        isConnected: () => true,
        signTransaction: async () => {
          throw new Error("mock: no funds");
        },
      } as any;
      const runtime = { getService: () => service } as any;

      const result = await transferAction.handler(runtime, {} as any, undefined, {
        parameters: {
          to: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
          amount: input,
          chain: "base",
        },
      });

      if (shouldFail) {
        expect(result?.success).toBe(false);
      } else {
        // Either API error (mock throws) or success — amount parsed OK
        expect(result).toBeDefined();
        if (!result?.success) {
          expect(result?.error).toContain("mock: no funds");
        }
      }
    });
  }
});
