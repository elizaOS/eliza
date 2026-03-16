# Building Secure Contracts

Comprehensive smart contract security toolkit based on Trail of Bits' [Building Secure Contracts](https://github.com/crytic/building-secure-contracts) framework.

**Author:** Omar Inuwa

## Overview

This plugin provides 11 specialized skills for smart contract security across multiple blockchain platforms:

- **6 Vulnerability Scanners** for platform-specific attack patterns
- **5 Development Guidelines Assistants** for secure development practices

## Installation

```
/plugin install trailofbits/skills/plugins/building-secure-contracts
```

---

## Vulnerability Scanners

Platform-specific vulnerability detection based on Trail of Bits' [Not So Smart Contracts](https://github.com/crytic/not-so-smart-contracts) repository.

### Algorand Vulnerability Scanner
**Skill:** `/algorand-vulnerability-scanner`

Scans Algorand/TEAL codebases for 11 vulnerability patterns including:
- Rekeying vulnerabilities
- Unchecked transaction fees
- Asset closing issues
- Group size checks
- Time-based replay attacks
- And 6 more patterns

### Cairo Vulnerability Scanner
**Skill:** `/cairo-vulnerability-scanner`

Analyzes StarkNet/Cairo smart contracts for 6 vulnerability patterns:
- Arithmetic overflow/underflow
- Reentrancy
- Uninitialized storage
- Authorization bypass
- And 2 more patterns

### Cosmos Vulnerability Scanner
**Skill:** `/cosmos-vulnerability-scanner`

Detects security issues in Cosmos SDK modules for 9 patterns:
- Undelegation time validation
- Amount validation
- Unbonding validation
- Rounding issues
- And 5 more patterns

### Solana Vulnerability Scanner
**Skill:** `/solana-vulnerability-scanner`

Scans Solana/Anchor programs for 6 critical vulnerabilities:
- Arbitrary CPI
- Improper PDA validation
- Missing ownership checks
- Signer authorization
- And 2 more patterns

### Substrate Vulnerability Scanner
**Skill:** `/substrate-vulnerability-scanner`

Analyzes Substrate pallets for 7 security issues:
- BadOrigin handling
- Insufficient weight
- Panics on overflow
- Unsigned transaction validation
- And 3 more patterns

### TON Vulnerability Scanner
**Skill:** `/ton-vulnerability-scanner`

Detects vulnerabilities in TON smart contracts for 3 patterns:
- Replay protection
- Unprotected receiver
- Sender validation issues

---

## Development Guidelines Assistants

Based on Trail of Bits' [Development Guidelines](https://github.com/crytic/building-secure-contracts/tree/master/development-guidelines).

### Audit Prep Assistant
**Skill:** `/audit-prep-assistant`

Prepare your codebase for security reviews with a comprehensive checklist:
1. **Set review goals** - Define objectives and concerns
2. **Resolve easy issues** - Run static analysis (Slither, dylint, golangci-lint)
3. **Ensure accessibility** - Build instructions, frozen commits, scope clarity
4. **Generate documentation** - Flowcharts, user stories, glossaries

**Use this:** 1-2 weeks before your audit to maximize review effectiveness.

### Code Maturity Assessor
**Skill:** `/code-maturity-assessor`

Systematic code maturity evaluation using Trail of Bits' 9-category framework:
- Arithmetic safety
- Auditing practices
- Authentication/Access controls
- Complexity management
- Decentralization
- Documentation quality
- Transaction ordering risks
- Low-level manipulation
- Testing and verification

**Output:** Professional maturity scorecard with evidence-based ratings and improvement roadmap.

### Guidelines Advisor
**Skill:** `/guidelines-advisor`

Comprehensive development best practices advisor covering:
- **Documentation & Specifications** - Generate system descriptions and architectural diagrams
- **Architecture Analysis** - Optimize on-chain/off-chain distribution
- **Upgradeability Review** - Assess upgrade patterns and delegatecall proxies
- **Implementation Quality** - Review functions, inheritance, events
- **Common Pitfalls** - Identify security anti-patterns
- **Dependencies** - Evaluate library usage
- **Testing** - Suggest improvements

**Use this:** Throughout development for architectural and implementation guidance.

### Secure Workflow Guide
**Skill:** `/secure-workflow-guide`

Interactive 5-step secure development workflow:
1. **Known Security Issues** - Run Slither with 70+ detectors
2. **Special Features** - Check upgradeability, ERC conformance, token integration
3. **Visual Inspection** - Generate inheritance graphs, function summaries, authorization maps
4. **Security Properties** - Document properties, set up Echidna/Manticore
5. **Manual Review** - Analyze privacy, front-running, cryptography, DeFi risks

**Use this:** On every check-in or before deployment for continuous security validation.

### Token Integration Analyzer
**Skill:** `/token-integration-analyzer`

Comprehensive token security analysis for both implementations and integrations:
- **ERC20/ERC721 Conformity** - Validate standard compliance
- **Contract Composition** - Assess complexity and SafeMath usage
- **Owner Privileges** - Review upgradeability, minting, pausability, blacklists
- **20+ Weird Token Patterns** - Check for non-standard behaviors (missing returns, fee-on-transfer, rebasing, etc.)
- **On-chain Analysis** - Query deployed contracts for scarcity and distribution
- **Integration Safety** - Verify defensive patterns and safe transfer usage

**Use this:** When building tokens or integrating with external tokens.

---

## Skill Organization

```
building-secure-contracts/
└── skills/
    ├── algorand-vulnerability-scanner/
    ├── audit-prep-assistant/
    ├── cairo-vulnerability-scanner/
    ├── code-maturity-assessor/
    ├── cosmos-vulnerability-scanner/
    ├── guidelines-advisor/
    ├── secure-workflow-guide/
    ├── solana-vulnerability-scanner/
    ├── substrate-vulnerability-scanner/
    ├── token-integration-analyzer/
    └── ton-vulnerability-scanner/
```

---

## Example Workflows

### Pre-Audit Preparation
1. Run `/secure-workflow-guide` to ensure clean Slither report
2. Use `/code-maturity-assessor` to evaluate overall maturity
3. Run `/audit-prep-assistant` to prepare documentation and checklist
4. Share prepared package with auditors

### Platform-Specific Security Review
1. Run appropriate vulnerability scanner for your platform
2. Use `/guidelines-advisor` for implementation best practices
3. Run `/secure-workflow-guide` for comprehensive security checks
4. Address findings and re-scan

### Token Development/Integration
1. Run `/token-integration-analyzer` for conformity and weird patterns
2. Use `/guidelines-advisor` for token-specific best practices
3. Run `/secure-workflow-guide` for complete validation
4. Deploy with confidence

### Continuous Security
1. Run `/secure-workflow-guide` on every check-in
2. Use platform scanner for vulnerability detection
3. Monitor code maturity with `/code-maturity-assessor`
4. Maintain documentation with `/guidelines-advisor`

---

## Tool Integration

Many skills leverage security tools when available:
- **Slither** - Static analysis for Solidity (70+ detectors, visual diagrams, upgradeability checks)
- **Echidna** - Property-based fuzzing
- **Manticore** - Symbolic execution
- **Tealer** - Static analyzer for TEAL/PyTeal
- **Web3/Ethers** - On-chain queries for deployed contracts

**Note:** Skills gracefully adapt when tools are unavailable, performing manual analysis instead.

---

## Source Material

This plugin is based on Trail of Bits' open-source security resources:
- [Building Secure Contracts](https://github.com/crytic/building-secure-contracts)
- [Not So Smart Contracts](https://github.com/crytic/not-so-smart-contracts)
- [Weird ERC20](https://github.com/d-xo/weird-erc20)

---

## Related Skills

- **audit-context-building** - Build deep architectural context before vulnerability hunting
- **issue-writer** - Transform findings into professional audit reports
- **solidity-poc-builder** - Build proof-of-concept exploits for Solidity vulnerabilities

---

## Support

For questions or issues:
- [Trail of Bits Office Hours](https://meetings.hubspot.com/trailofbits/office-hours) - Every Tuesday
- [Empire Hacking Slack](https://join.slack.com/t/empirehacking/shared_invite/zt-h97bbrj8-1jwuiU33nnzg67JcvIciUw) - #crytic and #ethereum channels
