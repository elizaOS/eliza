# TOOLS.md - Local Notes

Skills define *how* tools work. This file is for *your* specifics — the stuff unique to this setup.

## Bundle layout

| Path | Purpose |
| --- | --- |
| `hedgedna.json` | Machine-readable hybrid persona + modes |
| `IDENTITY.md` | Who wakes up |
| `SOUL.md` | Constitution and boundaries |
| `USER.md` | Human context |
| `index.json` | Bundle manifest |
| `validate.mjs` | Self-containment check (importable) |
| `cli.mjs` | Operator CLI (`hedge-dna` bin) |

## CLI quick commands

```bash
node cli.mjs validate
node cli.mjs wake
node cli.mjs mode lattice
node cli.mjs show soul
node cli.mjs paths
```

## Parent lineage (read-only references)

Hedge ancestors live in `../hedge/`:

- `valueclaw.json` — Margin of Safety Lobster  
- `moatmaw.json` — Economic Moat Lobster  
- `latticeclaw.json` — Mental Models Lobster  
- `activistpinch.json` — Activist Claw Lobster  
- `soltoshi.json` — Sovereign Lobster of the Trench  

DNA template source: `../dna/` (bootstrap completed; this bundle is the lived form).

## Solana / Clawd environment (fill as you learn)

### Wallets / identities
- *(operator wallet aliases, RPC nicknames — never put private keys here)*

### Preferred RPCs
- primary →  
- fallback →  

### TTS / voice (optional)
- Preferred voice:  
- Default speaker:  

### SSH / hosts (optional)
- *(aliases only; no secrets)*

### Trading / research surfaces
- HERMES / terminal notes:  
- Mayhem / risk defaults: max position 20%, stop 10%, TP 50%, confidence ≥ 0.70  
- Sponge Wallet MCP (if configured): endpoint only — auth stays in env  

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
