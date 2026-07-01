/**
 * Pins the payout-status resilience fix.
 *
 * Before: a malformed EVM payout key (privateKeyToAccount throws) or a network
 * whose RPC setup throws (resolveEvmRpc/createPublicClient) would throw out of
 * getStatus(), 500-ing the entire redemption flow (quote/status/execute) even
 * when another network was fine. Now each per-network/per-wallet failure
 * degrades that single network to "not_configured" and getStatus() never throws.
 */
import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import * as realCloudBindings from "../../runtime/cloud-bindings";

const getCloudAwareEnv = mock();
const REAL_CLOUD_BINDINGS = { ...realCloudBindings };
mock.module("../../runtime/cloud-bindings", () => ({ ...REAL_CLOUD_BINDINGS, getCloudAwareEnv }));

const resolveEvmRpc = mock();
mock.module("../../config/evm-rpc", () => ({ resolveEvmRpc }));

const { payoutStatusService } = await import("../payout-status");

afterAll(() => {
  mock.module("../../runtime/cloud-bindings", () => REAL_CLOUD_BINDINGS);
});

beforeEach(() => {
  getCloudAwareEnv.mockReset();
  resolveEvmRpc.mockReset();
  resolveEvmRpc.mockReturnValue({
    source: "test",
    url: "https://rpc.invalid.example",
  });
});

test("getStatus() does not throw on a malformed EVM payout key", async () => {
  getCloudAwareEnv.mockReturnValue({
    EVM_PAYOUT_PRIVATE_KEY: "0xnot-a-valid-private-key",
  });

  // Must resolve, not throw (the old code threw in privateKeyToAccount).
  const status = await payoutStatusService.getStatus(true);

  expect(status.operational).toBe(false);
  expect(status.networks.length).toBeGreaterThan(0);
  expect(status.networks.every((n) => n.status !== "operational")).toBe(true);
});

test("getStatus() degrades a network whose RPC setup throws (no 500)", async () => {
  getCloudAwareEnv.mockReturnValue({
    EVM_PAYOUT_PRIVATE_KEY: `0x${"1".repeat(64)}`,
  });
  resolveEvmRpc.mockImplementation(() => {
    throw new Error("RPC not configured for network");
  });

  // Resolves despite resolveEvmRpc throwing for every EVM network.
  const status = await payoutStatusService.getStatus(true);

  const base = status.networks.find((n) => n.network === "base");
  expect(base).toBeDefined();
  expect(base?.status).not.toBe("operational");
  expect(status.operational).toBe(false);
});

test("isNetworkAvailable() reports unavailable instead of throwing", async () => {
  getCloudAwareEnv.mockReturnValue({ EVM_PAYOUT_PRIVATE_KEY: "0xbad" });
  const result = await payoutStatusService.isNetworkAvailable("base");
  expect(result.available).toBe(false);
  expect(typeof result.message).toBe("string");
});

test("production refuses PAYOUT_STATUS_ASSUME_OPERATIONAL instead of reporting networks available", async () => {
  getCloudAwareEnv.mockReturnValue({
    ENVIRONMENT: "production",
    PAYOUT_STATUS_ASSUME_OPERATIONAL: "1",
    PAYOUT_STATUS_SKIP_LIVE_BALANCE: "1",
    EVM_PAYOUT_WALLET_ADDRESS: "0x0000000000000000000000000000000000000001",
    SOLANA_PAYOUT_WALLET_ADDRESS: "11111111111111111111111111111111",
  });

  const status = await payoutStatusService.getStatus(true);

  expect(status.operational).toBe(false);
  expect(status.warnings[0]).toContain("PAYOUT_STATUS_ASSUME_OPERATIONAL");
  expect(status.networks.every((network) => network.status !== "operational")).toBe(true);

  const result = await payoutStatusService.isNetworkAvailable("base");
  expect(result.available).toBe(false);
  expect(result.message).toContain("PAYOUT_STATUS_ASSUME_OPERATIONAL");
});
