// Fixtures shaped against the REAL upstream @stwd/sdk v0.10.1 contract
// (node_modules/@stwd/sdk/dist/types.d.ts). These are deliberately typed with
// the SDK's own interfaces so a future SDK shape change breaks compilation here
// instead of silently drifting from the parsers in src/routes/steward-bridge.ts.
//
// Key contract facts encoded below (verified against the d.ts):
//   - PolicyResult = { policyId, type, passed: boolean, reason? }  (NO `status`)
//   - TxRecord.createdAt / signedAt / confirmedAt are `Date` objects
//   - AgentBalance nests under `balances: { native, nativeFormatted, chainId, symbol }`
//   - StewardClient.signTransaction -> { txHash } | { signedTx } | StewardPendingApproval
//   - StewardPendingApproval = { status: "pending_approval", results: PolicyResult[] }
import type {
  AgentBalance,
  PolicyResult,
  SignRequest,
  TxRecord,
} from "@stwd/sdk";

export const sdkPolicyResultRejected: PolicyResult = {
  policyId: "policy-spend-limit",
  type: "spending-limit",
  passed: false,
  reason: "Exceeds per-tx spending limit",
};

export const sdkPolicyResultPassed: PolicyResult = {
  policyId: "policy-allowed-chains",
  type: "allowed-chains",
  passed: true,
};

const baseRequest: SignRequest = {
  agentId: "agent-alpha",
  tenantId: "tenant-1",
  to: "0xfeed000000000000000000000000000000000000",
  value: "1000000000000000000",
  chainId: 8453,
};

/** A confirmed TxRecord with a real Date createdAt and a txHash. */
export const sdkTxRecordConfirmed: TxRecord = {
  id: "tx-confirmed",
  agentId: "agent-alpha",
  status: "confirmed",
  request: { ...baseRequest },
  txHash: "0xconfirmedhash000000000000000000000000000000000000000000000000abcd",
  policyResults: [sdkPolicyResultPassed],
  createdAt: new Date("2026-05-18T12:00:00.000Z"),
  signedAt: new Date("2026-05-18T12:00:05.000Z"),
  confirmedAt: new Date("2026-05-18T12:00:30.000Z"),
};

/** A pending TxRecord carrying a rejecting policy result; no txHash yet. */
export const sdkTxRecordPending: TxRecord = {
  id: "tx-pending",
  agentId: "agent-alpha",
  status: "pending",
  request: {
    ...baseRequest,
    to: "0xdead000000000000000000000000000000000000",
    value: "500000000000000000",
    chainId: 1,
  },
  policyResults: [sdkPolicyResultRejected],
  createdAt: new Date("2026-05-18T13:00:00.000Z"),
};

/** AgentBalance as returned by StewardClient.getBalance(). */
export const sdkAgentBalance: AgentBalance = {
  agentId: "agent-alpha",
  walletAddress: "0xabc0000000000000000000000000000000000000",
  balances: {
    native: "2500000000000000000",
    nativeFormatted: "2.5",
    chainId: 8453,
    symbol: "ETH",
  },
};
