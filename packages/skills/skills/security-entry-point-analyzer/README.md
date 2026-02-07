# Entry Point Analyzer

A Claude skill for systematically identifying **state-changing** entry points in smart contract codebases to guide security audits.

## Purpose

When auditing smart contracts, examining each file or function individually is inefficient. What auditors need is to start from **entry points**—the externally callable functions that represent the attack surface. This skill automates the identification and classification of state-changing entry points, excluding view/pure/read-only functions that cannot directly cause loss of funds or state corruption.

## Supported Languages

| Language | File Extensions | Framework Support |
|----------|-----------------|-------------------|
| Solidity | `.sol` | OpenZeppelin, custom modifiers |
| Vyper | `.vy` | Native patterns |
| Solana | `.rs` | Anchor, Native |
| Move | `.move` | Aptos, Sui |
| TON | `.fc`, `.func`, `.tact` | FunC, Tact |
| CosmWasm | `.rs` | cw-ownable, cw-controllers |

## Access Classifications

The skill categorizes entry points into four levels:

1. **Public (Unrestricted)** — Callable by anyone; highest audit priority
2. **Role-Restricted** — Limited to specific roles (admin, governance, guardian, etc.)
3. **Review Required** — Ambiguous access patterns needing manual verification
4. **Contract-Only** — Internal integration points (callbacks, hooks)

## Output

Generates a structured markdown report with:
- Summary table of entry point counts by category
- Detailed tables for each access level
- Function signatures with file:line references
- Restriction patterns and role assignments
- List of analyzed files

## Usage

Trigger the skill with requests like:
- "Analyze the entry points in this codebase"
- "Find all external functions and access levels"
- "List audit flows for src/core/"
- "What privileged operations exist in this project?"

## Directory Filtering

Specify a subdirectory to limit scope:
- "Analyze only `src/core/`"
- "Find entry points in `contracts/protocol/`"

## Role Detection

The skill infers roles from common patterns:

| Pattern | Detected Role |
|---------|---------------|
| `onlyOwner`, `msg.sender == owner` | Owner |
| `onlyAdmin`, `ADMIN_ROLE` | Admin |
| `onlyGovernance`, `governance` | Governance |
| `onlyGuardian`, `onlyPauser` | Guardian |
| `onlyKeeper`, `onlyRelayer` | Keeper/Relayer |
| `onlyStrategy`, `strategist` | Strategist |
| Dynamic checks (`authorized[msg.sender]`) | Review Required |

## Installation

```
/plugin install trailofbits/skills/plugins/entry-point-analyzer
```

## License

See LICENSE.txt for terms.
