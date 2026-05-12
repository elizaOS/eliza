---
title: "TEE Plugin"
sidebarTitle: "TEE"
description: "Trusted Execution Environment plugin for Eliza — secure key derivation and remote attestation."
---

The TEE plugin provides secure key derivation and remote attestation capabilities within Trusted Execution Environments for Eliza agents.

**Package:** `@elizaos/plugin-tee`

## Overview

This plugin enables agents to operate within a Trusted Execution Environment, providing hardware-backed security guarantees for sensitive operations. It supports two primary capabilities:

- **Secure key derivation** — Generate cryptographic keys that never leave the enclave
- **Remote attestation** — Prove to external parties that code is running in a genuine TEE

## Installation

```bash
eliza plugins install tee
```

## Auto-Enable

Auto-enables when `TEE_MODE` is set.

## Configuration

| Environment Variable | Required | Description |
|---------------------|----------|-------------|
| `TEE_MODE` | No | TEE operating mode |

### Example

```bash
export TEE_MODE=sgx
```

## When to Use

- Agents handling cryptographic keys or secrets
- Scenarios requiring verifiable execution integrity
- Deployments where data confidentiality must be hardware-enforced
