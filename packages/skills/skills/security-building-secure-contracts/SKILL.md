---
name: security-building-secure-contracts
description: "Smart contract security toolkit based on Trail of Bits' Building Secure Contracts framework. Includes vulnerability scanners for 6 blockchain platforms and 5 development guidelines assistants for audit preparation, code maturity assessment, and secure workflows."
---

# Building Secure Contracts

A comprehensive security toolkit for smart contract development and auditing, based on Trail of Bits' [Building Secure Contracts](https://github.com/crytic/building-secure-contracts) framework.

## When to Use

- Auditing smart contracts on any supported blockchain platform
- Preparing a codebase for a security review
- Assessing code maturity and development practices
- Scanning for platform-specific vulnerability patterns
- Analyzing token integration risks (ERC20/ERC721 edge cases)

## When NOT to Use

- Non-blockchain codebases (use general security skills instead)
- Vulnerability discovery without a specific platform target (use audit-context-building)
- Writing exploit PoCs (use solidity-poc-builder)

## Sub-Skills

This skill contains 11 specialized sub-skills organized into two categories:

### Vulnerability Scanners (6 platforms)

| Scanner | Platform | Patterns | Skill Path |
|---------|----------|----------|------------|
| **Algorand** | TEAL / PyTeal | 11 patterns (rekeying, unchecked fees, field validation) | [skills/algorand-vulnerability-scanner/SKILL.md](skills/algorand-vulnerability-scanner/SKILL.md) |
| **Cairo** | StarkNet | 6 patterns (unchecked arithmetic, storage collision, access control) | [skills/cairo-vulnerability-scanner/SKILL.md](skills/cairo-vulnerability-scanner/SKILL.md) |
| **Cosmos** | CosmWasm | 9 patterns (denom validation, authorization, IBC packets) | [skills/cosmos-vulnerability-scanner/SKILL.md](skills/cosmos-vulnerability-scanner/SKILL.md) |
| **Solana** | Anchor / Rust | 6 patterns (arbitrary CPI, PDA validation, signer checks) | [skills/solana-vulnerability-scanner/SKILL.md](skills/solana-vulnerability-scanner/SKILL.md) |
| **Substrate** | Polkadot | 7 patterns (arithmetic overflow, weights/fees, bad randomness) | [skills/substrate-vulnerability-scanner/SKILL.md](skills/substrate-vulnerability-scanner/SKILL.md) |
| **TON** | FunC / Tact | 3 patterns (missing sender check, integer overflow, gas handling) | [skills/ton-vulnerability-scanner/SKILL.md](skills/ton-vulnerability-scanner/SKILL.md) |

### Development Guidelines Assistants (5 tools)

| Assistant | Purpose | Skill Path |
|-----------|---------|------------|
| **Audit Prep** | Prepare codebase for security review using Trail of Bits' checklist | [skills/audit-prep-assistant/SKILL.md](skills/audit-prep-assistant/SKILL.md) |
| **Code Maturity** | Assess code maturity across 9 categories (arithmetic, auth, complexity, etc.) | [skills/code-maturity-assessor/SKILL.md](skills/code-maturity-assessor/SKILL.md) |
| **Guidelines Advisor** | Development advisor based on Trail of Bits' best practices | [skills/guidelines-advisor/SKILL.md](skills/guidelines-advisor/SKILL.md) |
| **Secure Workflow** | 5-step secure development workflow guide | [skills/secure-workflow-guide/SKILL.md](skills/secure-workflow-guide/SKILL.md) |
| **Token Integration** | Analyze 20+ weird ERC20/ERC721 token patterns | [skills/token-integration-analyzer/SKILL.md](skills/token-integration-analyzer/SKILL.md) |

## Usage

Select the appropriate sub-skill based on your task:

1. **Starting an audit?** Begin with the platform-specific vulnerability scanner
2. **Preparing for audit?** Use the Audit Prep Assistant
3. **Reviewing development practices?** Use Code Maturity Assessor or Guidelines Advisor
4. **Integrating tokens?** Use Token Integration Analyzer
5. **Setting up workflows?** Use Secure Workflow Guide

## Tool Integration

- **Slither** (Solidity): `slither . --detect all`
- **Tealer** (Algorand): `tealer contract.teal --detect all`
- **cargo-audit** (Rust/Substrate): `cargo audit`

## Source Material

Based on Trail of Bits' [Building Secure Contracts](https://github.com/crytic/building-secure-contracts) and [Not So Smart Contracts](https://github.com/crytic/not-so-smart-contracts) repositories.
