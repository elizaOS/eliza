# 🛡️ @elizaos/plugin-security-gate

Deterministic local prompt injection defense, AST code hazard sandboxing, and autonomous agent safety guardrails for ElizaOS.

---

## Features

- 🔒 **100% Local-First by Default**: Runs entirely within the local node process with **zero external network requests and zero data exfiltration**.
- ⚡ **Sub-Millisecond Deterministic Latency**: Instant regex & heuristic AST evaluation (<1ms) for prompts, tool calls, and model inputs.
- 🛑 **Fail-Closed Safety**: High-risk injection payloads and dangerous commands are immediately blocked from executing.
- 🛡️ **Threat Interception**:
  - Adversarial prompt injections (instruction overrides, system prompt spoofing).
  - Jailbreak personas (DAN mode, Developer Mode overrides).
  - Destructive code execution (`os.system`, `subprocess`, dynamic `eval`, `rm -rf`).
  - Accidental credential disclosures (private keys, raw hex seed material).
- 🌐 **Optional Opt-In Remote Oracle**: Connect to custom micro-oracle endpoints by explicitly setting `SECURITY_GATE_URL` (enforces 3s timeout and graceful fallback).

---

## Installation & Configuration

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
      "SECURITY_GATE_URL": "https://your-custom-oracle-domain.com",
      "SECURITY_GATE_API_KEY": "your-optional-api-key"
    }
  }
}
```

---

## Components Included

- **`securityGatePreHandler` (ChatPreHandler)**: Fail-closed inbound guard that intercepts and analyzes inbound messages in sub-millisecond (<1ms) time before any LLM inference or tool execution occurs, short-circuiting attacks immediately.
- **`SECURITY_GATE_EVALUATOR`**: Evaluates conversational turns for prompt injections, jailbreaks, or policy violations and logs audit records into agent memory via standard Evaluator processors.
- **`INSPECT_SAFETY` Action**: Explicitly audits code snippets, transaction calldata, or dynamic instructions before critical tool execution.
- **`securityStatusProvider`**: Injects active security gate defense status and threat telemetry into the agent's context memory.

---

## Testing

```bash
bun test plugins/plugin-security-gate
# or
bunx vitest run
```

Comprehensive unit tests cover prompt injection blocking, AST command detection, safe pass-through, and local fail-safe handling.

---

## License

MIT
