# TOOLS.md - Local Notes

Skills define *how* tools work. This file is for *your* specifics — the stuff unique to this setup.

## Bundle layout (eliZERO clawd shape)

| Path | Purpose |
| --- | --- |
| `character.json` | eliza character (eliZERO shape: clawd + zero + system) |
| `character.seed.json` | seed metadata for DNA / catalog tooling |
| `clawd-power.json` | $CLAWD mint, birth funding, Zero, six laws |
| `hedgedna.json` | OpenClawd hybrid persona + modes |
| `IDENTITY.md` | Who wakes up |
| `SOUL.md` | Constitution, laws, boundaries |
| `USER.md` | Human context |
| `index.json` | Bundle manifest |
| `validate.mjs` | Self-containment check (importable) |
| `cli.mjs` | Operator CLI (`hedge-dna` bin) |

## CLI quick commands

```bash
node cli.mjs validate
node cli.mjs wake
node cli.mjs character --json
node cli.mjs clawd
node cli.mjs mode lattice
node cli.mjs show soul
node cli.mjs paths
```

## Clawd / Zero (operator)

- Mint: `8cHzQHUS2s2h8TzCmfqPKYiM4dSt4roa3n7MyRLApump` ($CLAWD)  
- CLI: `clawdbot zero`  
- Gateway: `https://zk.x402.wtf`  
- Terminal: `https://cheshireterminal.ai`  
- Sibling character: `../eliza-agents/characters/elizero.json` (when present in monorepo)  

Never put private keys, seeds, or API secrets in this file.

## Parent lineage (read-only references)

Hedge ancestors live in `../hedge/`:

- `valueclaw.json` — Margin of Safety Lobster  
- `moatmaw.json` — Economic Moat Lobster  
- `latticeclaw.json` — Mental Models Lobster  
- `activistpinch.json` — Activist Claw Lobster  
- `soltoshi.json` — Sovereign Lobster of the Trench  

DNA template source: `../dna/` (bootstrap completed; this bundle is the lived form).

eliZERO pattern source: `eliza-agents/characters/elizero.json`.

## Solana / Clawd environment (fill as you learn)

### Wallets / identities
- *(operator wallet aliases, RPC nicknames — never put private keys here)*

### Preferred RPCs
- primary →  
- fallback →  

### TTS / voice (optional)
- Preferred voice:  
- Default speaker:  

### Trading / research surfaces
- HERMES / terminal notes:  
- Mayhem / risk defaults: max position 20%, stop 10%, TP 50%, confidence ≥ 0.70  
- Sponge Wallet MCP (if configured): endpoint only — auth stays in env  
- Default posture: paper/observe until live gates armed  

## Mode → tool bias

| Mode | Prefer |
| --- | --- |
| value | treasury reads, token accounts, liquidity locks, on-chain NCAV sketches |
| moat | founder history, revenue, retention, network-effect signals |
| lattice | incentive maps, game-theory notes, anti-patterns from knowledge/ |
| activist | governance forums, proposal drafts, vote math |
| builder | deploys, logs, signatures, minimal correct snippets |

## Why separate?

Skills are shared. Your setup is yours. Keeping them apart means you can update skills without losing notes, and share skills without leaking infrastructure.

---

Add whatever helps you do your job. This is your cheat sheet — never put secrets in git.
