<!-- ╔══════════════════════════════════════════════════════╗ -->
<!-- ║  clawd-go/ — Solana Go SDK wrapper                   ║ -->
<!-- ╚══════════════════════════════════════════════════════╝ -->

<div align="center">

```
  ██████╗ ██████╗      ██████╗  ██████╗
 ██╔════╝██╔═══██╗    ██╔════╝ ██╔═══██╗
 ██║     ██║   ██║    ██║  ███╗██║   ██║
 ██║     ██║   ██║    ██║   ██║██║   ██║
 ╚██████╗╚██████╔╝    ╚██████╔╝╚██████╔╝
  ╚═════╝ ╚═════╝      ╚═════╝  ╚═════╝
```

**clawd-go — Solana Go SDK with zero-config RPC + free AI**

[![Go](https://img.shields.io/badge/go-1.21+-00ADD8?style=flat-square&logo=go)](https://go.dev)
[![Solana](https://img.shields.io/badge/solana--go-v1.16.0-9945FF?style=flat-square)](https://github.com/gagliardetto/solana-go)
[![x402](https://img.shields.io/badge/x402.wtf-free%20AI-C85C2B?style=flat-square)](https://x402.wtf)

</div>

---

## What it does

`clawd-go` wraps [solana-go v1.16.0](https://github.com/gagliardetto/solana-go) with:

- **Zero-config RPC** — defaults to Helius public endpoint, no keys needed
- **Free AI** — x402.wtf LLM proxy included out of the box
- **CLAWD identity** — on-chain agent identity via Metaplex MPL Core

## Quick start

```bash
cd clawd-go
go run clawd.go
```

## Structure

```
clawd-go/
├── clawd.go        # Main entrypoint
├── go.mod          # Go module definition
├── go.sum          # Dependency checksums
└── pkg/            # Shared packages
```

## Environment

```bash
HELIUS_RPC_URL=https://mainnet.helius-rpc.com/?api-key=...
CLAWD_API_KEY=...  # optional — free tier uses x402.wtf
```

---

> Part of [OpenClawd](https://x402.wtf) · MIT
