# 🛡️ @elizaos/plugin-security-gate

Deterministic local prompt injection defense, dangerous code pattern detection, and autonomous agent safety guardrails for ElizaOS.

---

## 🌟 Features

- 🔒 **100% Local-First by Default**: Runs entirely within the local node/bun process with **zero external network requests and zero data exfiltration**.
- ⚡ **Sub-Millisecond Deterministic Latency**: Instant regex pattern matching, heuristic command detection, and Unicode normalization (<1ms) for prompts, tool calls, and model inputs.
- 🛑 **Fail-Closed Safety**: High-risk injection payloads and dangerous commands are immediately blocked from executing.
- 🛡️ **Comprehensive Threat Interception**:
  - Adversarial prompt injections (instruction overrides, system prompt spoofing).
  - Jailbreak personas (DAN mode, Developer Mode overrides).
  - Obfuscation evasions (Zero-width characters `\u200B`, null-bytes `\0`).
  - Dangerous code execution patterns (`os.system`, `subprocess`, dynamic `eval`, `rm -rf`).
  - Accidental credential disclosures (private keys, raw hex seed material).
- 🌐 **Optional Opt-In Remote Oracle**: Connect to custom micro-oracle endpoints by explicitly setting `SECURITY_GATE_URL` (enforces 3s timeout and graceful fallback).

---

## 📦 Installation & Configuration

### 1. Add to Character JSON

```json
{
  "name": "SecureAgent",
  "plugins": ["@elizaos/plugin-security-gate"]
}
```

By default, the plugin runs in **Local Deterministic Mode** with no external network access.

### 2. (Optional) Configure Remote Micro-Oracle Verification

If you wish to route safety checks through an external micro-oracle:

```json
{
  "name": "SecureAgent",
  "plugins": ["@elizaos/plugin-security-gate"],
  "settings": {
    "secrets": {
      "SECURITY_GATE_URL": "https://your-security-gate-oracle.example.com",
      "SECURITY_GATE_API_KEY": "your-optional-api-key"
    }
  }
}
```

---

## 🧱 Components Included

- **`securityGatePreHandler` (ChatPreHandler)**: Fail-closed inbound guard that intercepts and analyzes inbound messages in sub-millisecond (<1ms) time before LLM inference or action dispatch, short-circuiting adversarial turns immediately.
- **`SECURITY_GATE_EVALUATOR`**: Evaluates conversational turns for prompt injections, jailbreaks, or policy violations and logs audit records into agent memory via standard Evaluator processors.
- **`INSPECT_SAFETY` Action**: Explicitly audits code snippets, transaction calldata, or dynamic instructions before critical tool execution (auto-detecting code snippets or accepting explicit `isCode` options). Delivers strictly typed `Content` and `ContentValue` callbacks.
- **`securityStatusProvider`**: Injects active security gate defense status and threat telemetry into the agent's context memory.

---

## 💻 Action Callback Contract (`ContentValue`)

When calling `INSPECT_SAFETY`, the action callback emits structured telemetry adhering to ElizaOS core typing:

```typescript
import { inspectSafetyAction } from "@elizaos/plugin-security-gate";

const result = await inspectSafetyAction.handler(
  runtime,
  message,
  state,
  {},
  async (callbackContent) => {
    // callbackContent conforms to Content
    console.log(callbackContent.text);
    // callbackContent.data conforms to Record<string, ContentValue>
    const { verdict, riskScore, threats, executionTimeMs, oracle, isCode } = callbackContent.data as {
      verdict: "ALLOW" | "WARN" | "BLOCK";
      riskScore: number;
      threats: string[];
      executionTimeMs: number;
      oracle?: boolean;
      isCode?: boolean;
    };
  }
);
```

---

## 🧪 Testing

```bash
bun test plugins/plugin-security-gate
# or
bunx vitest run
```

Comprehensive unit tests cover prompt injection blocking, zero-width character evasion normalization, dangerous command pattern detection, safe pass-through, and local fail-safe handling.

---

## 📚 Documentation & Specifications

- [🧙‍♂️ Ethereum Magicians ERC Proposal: IAgentTransactionGuard](https://ethereum-magicians.org/t/erc-ai-agent-proof-of-safety-attestation-transaction-guard-standard-iagenttransactionguard/29658)

---

## 📄 License

MIT
