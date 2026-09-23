---
name: web3-integration-risk-gate
description: >-
  use this when a coding agent is about to integrate a Web3 SDK/protocol/wallet
  repo — must call x402 integration-risk and change downstream behavior
  (stop/caution/proceed); L1/L2 workflow gate
license: MIT
---
# Web3 integration-risk gate

Use when about to add, wire, or deeply integrate a Web3 SDK, protocol client, wallet connector, on-chain admin/upgrade path, or similar third-party Web3 repository — **before** writing integration code or installing the dependency.

## Frozen endpoint
`POST https://x402-integration-risk.vercel.app/v1/decide/integration-risk`
Body: `{ "repository": "<url or owner/name>", "intended_integration": "<what you will wire>" }`
Price: $0.10 (x402).

## Install
```bash
npx --yes github:xbox002000/x402-integration-risk-gate -- help
```
Payment env: see package `PAYMENT.md` (`CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`, `CDP_WALLET_SECRET`).

## Call (preferred)
```bash
npx x402-integration-risk-gate gate \
  --repository "<url>" \
  --intended-integration "<intent>" \
  --out /tmp/gate-result.json
npx x402-integration-risk-gate apply /tmp/gate-result.json /tmp/gate-sandbox
```

## Required chain
1. **Trigger** from Web3 integrate intent (automatic)
2. **Call** endpoint (pay/settle)
3. **Decision** parse JSON
4. **Downstream behavior change** (mandatory):
   - `DO_NOT_INTEGRATE` → hard stop
   - `PROCEED_WITH_CAUTION` → continue only with mitigations
   - `PROCEED` → allow
   - `INSUFFICIENT_EVIDENCE` → gather more or stop
   Calling then ignoring the decision = **FAIL**

## Do not
- Claim L3 from self-payment
- Add UI / new public product endpoints / outreach
