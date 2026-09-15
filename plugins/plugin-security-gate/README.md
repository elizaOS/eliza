# @elizaos/plugin-security-gate 🛡️

Official Security Gate x402 plugin for **ElizaOS** (`ai16z/eliza`).

Provides **sub-5ms deterministic prompt injection defense**, **malicious AST code sandboxing**, and **cryptographic zero-liability audit proofs** for autonomous agents.

---

## Installation

```bash
pnpm add @elizaos/plugin-security-gate
# or
npm install @elizaos/plugin-security-gate
```

---

## Configuration

In your `.env` or Eliza character configuration:

```env
SECURITY_GATE_URL="https://agent-security-gate-x402-212942243360.asia-northeast3.run.app"
AGENT_VAULT_KEY="your_prefunded_vault_key" # Optional
```

---

## Usage in Character JSON

Add `"@elizaos/plugin-security-gate"` to your character's `plugins` array:

```json
{
  "name": "DeFiTrader",
  "plugins": ["@elizaos/plugin-security-gate"],
  "settings": {
    "secrets": {
      "SECURITY_GATE_URL": "https://agent-security-gate-x402-212942243360.asia-northeast3.run.app"
    }
  }
}
```

---

## Features

* **`SECURITY_GATE_EVALUATOR`**: Intercepts inbound prompts and agent responses in <5ms, blocking DAN jailbreaks and system breakouts.
* **`INSPECT_SAFETY` Action**: Allows the agent to explicitly inspect a calldata payload or external URL output before triggering on-chain transactions.
* **`securityStatusProvider`**: Injects live cryptographic security state into agent context memory.

---

## License

MIT License &copy; 2026 Security Gate Team
