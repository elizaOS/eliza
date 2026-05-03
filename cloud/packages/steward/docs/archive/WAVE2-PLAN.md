# Wave 2: ERC-8004 Integration + Key Export + Dynamic Policies

**Date:** 2026-04-11
**Depends on:** Wave 1 (Q, R, S, T, U) — all completing now

---

## Worker V — ERC-8004 Contract Integration
**Branch:** `feat/erc8004-contracts`
**New package:** `packages/erc8004/`

**Tasks:**
1. **Package setup:**
   - `packages/erc8004/src/registries.ts` — Identity, Reputation, Validation registry clients
   - `packages/erc8004/src/abis/` — Contract ABIs for all 3 registries
   - `packages/erc8004/src/chains.ts` — multi-chain config (Base, Ethereum, BSC, Arbitrum)
   - `packages/erc8004/src/chitin.ts` — Chitin Protocol SDK wrapper for easy registration

2. **Identity registration:**
   - `registerAgent(agentId, agentCard, chain)` → mints ERC-8004 NFT
   - Agent card JSON: name, description, steward API URL, wallet address, capabilities
   - Store tokenId in agents.erc8004TokenId
   - Multi-chain: primary on Base, optional mirrors

3. **Reputation:**
   - `postFeedback(agentId, score, comment, chain)` → write to Reputation Registry
   - `getReputation(agentId)` → aggregate score across chains
   - Score types: positive (successful tx), negative (policy violation), neutral (info)

4. **Validation:**
   - `recordValidation(agentId, evidenceHash, chain)` → write to Validation Registry
   - Policy evaluation results as validation evidence

5. **DB tables:**
   - `agent_registrations` — tracks which chains each agent is registered on
   - `reputation_cache` — cached reputation scores (refresh periodically)
   - `registry_index` — known registries (steward + tenant registries)

6. **API endpoints** (in packages/api):
   - `POST /agents/:id/register-onchain` — mint ERC-8004 identity
   - `GET /agents/:id/onchain` — get on-chain registration status + reputation
   - `POST /agents/:id/feedback` — post reputation feedback
   - `GET /discovery/agents` — cross-registry agent search
   - `GET /discovery/registries` — list known registries

7. **Tenant config:**
   - `registryConfig` field on tenant_configs:
     - `primaryChain` (default: 8453 Base)
     - `mirrorChains` (optional: [1, 56, 42161])
     - `customRegistryAddress` (white-label)
     - `autoRegister` (register agents on creation? default: false)

---

## Worker W — Key Export
**Branch:** `feat/key-export`
**Packages:** `packages/api/`, `packages/vault/`, `web/`

**Tasks:**

1. **Vault method:**
   - `Vault.exportPrivateKey(tenantId, agentId)` → decrypted private key string
   - Same decrypt logic as signing, but returns the key instead of signing with it
   - MUST log the export event

2. **API endpoints:**
   - `POST /user/me/wallet/export` — export user's personal wallet key
     - Requires: active session + re-authentication challenge
     - Re-auth: passkey verification OR email verification code
     - Returns: `{ privateKey: "0x...", address: "0x...", chain: "evm" }` + `{ privateKey: "base58...", address: "...", chain: "solana" }`
     - Audit log entry: "key_export" event
   - `POST /vault/:agentId/export` — export agent key (tenant admin only)
     - Requires: tenant-level auth (API key or admin JWT)
     - Same response format
     - Stricter audit logging

3. **Security:**
   - Rate limit: 1 export per hour per user
   - Re-authentication required (not just having a valid JWT)
   - Export event logged in transactions table with type "key_export"
   - Option to email notification on export (if email configured)
   - Response includes warning: "This key controls real funds. Store it securely."

4. **SDK:**
   - `client.exportUserWalletKey()` → `{ evm: { privateKey, address }, solana: { privateKey, address } }`
   - `client.exportAgentKey(agentId)` → same format

5. **Dashboard:**
   - "Export Private Key" button in Settings → Wallet section
   - Confirmation modal with warnings
   - Re-authentication challenge (passkey prompt)
   - Show key briefly (30 seconds), then auto-hide
   - Copy button

---

## Worker X — Reputation-Driven Dynamic Policies
**Branch:** `feat/reputation-policies`
**Packages:** `packages/policy-engine/`, `packages/api/`

**Tasks:**

1. **New policy type: `reputation-threshold`:**
   ```typescript
   {
     type: "reputation-threshold",
     enabled: true,
     config: {
       minScore: 80,        // minimum reputation score (0-100)
       action: "auto-approve" | "require-approval" | "block",
       source: "onchain" | "internal" | "both",
       fallbackAction: "require-approval"  // when reputation unavailable
     }
   }
   ```

2. **Policy engine integration:**
   - Before evaluating policies, fetch agent's reputation score
   - If `reputation-threshold` policy exists, check score against threshold
   - Score below threshold → apply configured action
   - Score unavailable → apply fallbackAction

3. **Dynamic limit adjustment:**
   - New policy type: `reputation-scaling`
   ```typescript
   {
     type: "reputation-scaling",
     enabled: true,
     config: {
       baseMaxPerTx: "0.1 ETH",
       maxMaxPerTx: "10 ETH",
       reputationCurve: "linear" | "logarithmic",
       // At reputation 0: baseMaxPerTx. At reputation 100: maxMaxPerTx
     }
   }
   ```

4. **Internal reputation (no chain needed):**
   - Steward calculates internal reputation from transaction history
   - Success rate, policy violation rate, transaction volume, account age
   - This works immediately, no ERC-8004 dependency
   - On-chain reputation supplements internal score

---

## Dependency Graph

```
Wave 1 (completing now):
  Q (ERC-8004 research) ✅
  R (Policies API) 🔄
  S (Audit API) ✅  
  T (Tenant dashboard) 🔄
  U (GHCR fix) ✅

Wave 2 (after merge):
  V (ERC-8004 contracts) — depends on Q's design doc
  W (Key export) — independent
  X (Reputation policies) — depends on V for on-chain, independent for internal
```
