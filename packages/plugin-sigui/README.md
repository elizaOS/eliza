# @elizaos/plugin-sigui

> **Sigui DePIN AI Security Oracle Plugin for ElizaOS**  
> Intercepts and pre-audits autonomous agent transactions before on-chain execution using fine-tuned vision models (Qwen2-VL-7B on AMD MI300X GPUs) and Zero-Knowledge proofs.

[![NPM Version](https://img.shields.io/npm/v/sigui-elizaos-plugin.svg?color=orange)](https://www.npmjs.com/package/sigui-elizaos-plugin)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![DOI](https://img.shields.io/badge/DOI-10.5281%2Fzenodo.20550562-blue)](https://doi.org/10.5281/zenodo.20550562)

---

## 🛡️ Why Sigui for ElizaOS Agents?

Autonomous AI agents executing Web3 transactions (swaps, transfers, approvals) without direct human oversight are prime targets for:
* **Drain Stars**: Malicious smart contracts draining agent treasuries via high-outdegree token transfers.
* **Mixing Chains**: Obfuscated laundering hops designed to evade static blacklists.
* **Honeypot Contracts & Rug Pulls**: Trapped liquidity or malicious bytecode.

`plugin-sigui` acts as a **real-time pre-execution firewall** for any ElizaOS agent. In `<50ms`, transaction graphs are visually and heuristically evaluated, returning an immutable verdict: `ALLOW`, `BLOCK`, or `ESCALATE`.

---

## 📦 Installation

```bash
npm install sigui-elizaos-plugin
# or
pnpm add sigui-elizaos-plugin
```

---

## ⚡ Quickstart

Add `siguiPlugin` to your ElizaOS agent configuration:

```typescript
import { siguiPlugin } from "@elizaos/plugin-sigui";

export const agent = {
  name: "SecurityAgent",
  plugins: [siguiPlugin],
};
```

---

## ⚙️ Configuration (.env)

| Variable | Description | Default |
| :--- | :--- | :--- |
| `SIGUI_API_URL` | URL of the Sigui Security Oracle Gateway | *required* |
| `SIGUI_API_KEY` | Optional bearer token for enterprise endpoints | `undefined` |
| `SIGUI_REQUIRE_ZK` | Require Groth16 validity proof for ALLOW verdicts | `false` |
| `SIGUI_FAIL_CLOSED` | Halt transaction execution if oracle is unreachable | `true` |

> **Note**: If `SIGUI_API_URL` is not set, the action will not be routed (validate returns false).

---

## 🧩 Components

### 1. Action: `EVALUATE_TRANSACTION_SECURITY`
* **Triggered by:** Any transaction intent (transfers, swaps, approvals).
* **Similes:** `CHECK_TRANSACTION_SAFETY`, `AUDIT_TRANSACTION`, `VERIFY_SMART_CONTRACT`, `IS_THIS_SAFE`.
* **Behavior:** Extracts destination address and value, calls the Sigui Security Engine to inspect visual topology.
* **Returns:** Advisory verdict — `ALLOW`, `BLOCK` (flags for review), or `ESCALATE` (requests human confirmation).

### 2. Provider: `SIGUI_THREAT_INTEL`
* **Behavior:** Injects the latest learned threat patterns (flagged addresses, attack topologies) into the agent's contextual memory on each turn.

---

## 🔬 Scientific Benchmark & Research

* **Model:** Qwen2-VL-7B fine-tuned via LoRA on ROCm / AMD MI300X.
* **Dataset:** [Sigui-DePIN-1M](https://huggingface.co/datasets/Ibonon/sigui-depin-1m) — 1,000,000 annotated transaction topologies.
* **Inference Latency:** Average `35.3ms` on AMD MI300X hardware.
* **Detection F1-Score:** `92.9%` against adversarial honeypots and drain patterns.
* **Research Paper:** [DOI: 10.5281/zenodo.20550562](https://doi.org/10.5281/zenodo.20550562)

---

## 📄 License

MIT © [Sigui Protocol](https://github.com/ibonon/Sigui)
