# Diogenes Plugin for ElizaOS (@elizaos/plugin-diogenes)

A drop-in **ElizaOS** plugin equipping autonomous Solana agents with:
- **SPL Token Risk Audits (`EVALUATE_SOLANA_TOKEN_RISK`)**: Verify freeze authority, mint authority, Token-2022 extensions, and honeypot transfer taxes before executing token swaps.
- **Smart Contract Honeypot Audits (`AUDIT_SMART_CONTRACT`)**: Audit Anchor and Solana Rust programs for backdoors, missing signer checks, and reentrancy bugs.
- **Pre-Execution Guardrails (`ENFORCE_GUARDRAIL`)**: Intercept user prompts and agent thoughts for prompt injection, key exfiltration, and wallet drains.
- **Zero-Fee Demo Mode & x402 Micropayments**: Instant testing with `demoMode: true` out of the box.

## Actions Available

### 1. `EVALUATE_SOLANA_TOKEN_RISK`
Analyzes any SPL token mint address in real time:
- Returns binary `should_transact` verdict
- Detects active freeze authority and unrevoked mint authority
- Returns verified slot and canonical reason codes (`CANONICAL_WRAPPED_SOL_RENOUNCED`, `TOKEN_2022_TRANSFER_FEE_RISK`, etc.)

Aliases: `CHECK_SPL_TOKEN_RISK`, `INSPECT_SOLANA_TOKEN`, `AUDIT_SPL_TOKEN`, `CHECK_FREEZE_AUTHORITY`.

### 2. `AUDIT_SMART_CONTRACT`
Audits Anchor / Rust smart contracts for security hazards and backdoors.

### 3. `ENFORCE_GUARDRAIL`
Pre-execution security barrier verifying that agent commands and prompts are free of prompt injection or destructive terminal instructions.

## Endpoints & Gateway
- **Production Gateway**: [https://diogenesgateway.com](https://diogenesgateway.com)
- **Standalone Package**: `@diogenesgateway/eliza-plugin-diogenes` (npm)
- **Repository**: [stand-out-of-my-sun/eliza-plugin-diogenes](https://github.com/stand-out-of-my-sun/eliza-plugin-diogenes)
