---
name: security-building-secure-contracts
description: "Guide secure smart contract development with best practices for Solidity, Rust (Solana/CosmWasm), and Move. Use when writing, reviewing, or hardening smart contracts against common vulnerability classes like reentrancy, integer overflow, access control issues, and flash loan attacks."
allowed-tools:
  - Bash
  - Read
  - Write
  - Glob
  - Grep
---

# Building Secure Smart Contracts

## When to Use

- Writing new smart contracts and need security-first patterns
- Reviewing contract code for common vulnerability classes
- Hardening existing contracts before audit or deployment
- Implementing access control, upgrade patterns, or token standards securely
- Evaluating contract architecture for systemic risks

## When NOT to Use

- General web application security (use other security skills)
- Off-chain backend code review
- Non-blockchain cryptographic protocol design

## Key Vulnerability Classes

### Solidity / EVM

| Vulnerability | Description | Mitigation |
|---------------|-------------|------------|
| Reentrancy | External calls allow recursive entry | Checks-Effects-Interactions pattern; ReentrancyGuard |
| Integer overflow/underflow | Arithmetic wraps silently (pre-0.8) | Use Solidity >=0.8 or SafeMath |
| Access control | Missing or incorrect permission checks | OpenZeppelin Ownable/AccessControl; multi-sig for admin |
| Flash loan manipulation | Price or governance manipulation via atomic loans | Time-weighted oracles; commit-reveal schemes |
| Front-running | Mempool observation enables MEV extraction | Commit-reveal; private mempools; batch auctions |
| Delegatecall injection | Arbitrary code execution via delegatecall | Restrict delegatecall targets; avoid user-controlled addresses |
| Storage collision | Proxy upgrade storage layout conflicts | Use EIP-1967 storage slots; OpenZeppelin upgradeable contracts |

### Solana / Rust

| Vulnerability | Description | Mitigation |
|---------------|-------------|------------|
| Missing signer check | Instructions accept unsigned accounts | Verify `account.is_signer` |
| Missing owner check | Accounts owned by wrong program | Verify `account.owner == program_id` |
| Account confusion | Wrong account type passed | Use discriminators; Anchor account validation |
| Arithmetic overflow | Unchecked math in native Rust | Use `checked_add`, `checked_mul`; saturating math |

## Secure Development Checklist

1. Use established, audited libraries (OpenZeppelin, Anchor)
2. Follow Checks-Effects-Interactions pattern
3. Implement comprehensive access control
4. Use time-weighted average prices for oracles
5. Add emergency pause mechanisms
6. Write invariant tests and fuzz tests
7. Get independent audit before mainnet deployment
8. Use formal verification where practical

## Testing Approach

- Unit tests for all state transitions
- Invariant/property-based tests for protocol invariants
- Fork tests against mainnet state
- Fuzz testing with Foundry or Echidna
- Symbolic execution with Halmos or Manticore

## Resources

- Trail of Bits: Building Secure Contracts — https://secure-contracts.com/
- OpenZeppelin Contracts — https://docs.openzeppelin.com/contracts/
- Solidity Security Pitfalls — https://github.com/sigp/solidity-security-blog
- Anchor Book — https://book.anchor-lang.com/
