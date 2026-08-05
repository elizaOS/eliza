# @openclawd/hedge-dna

Hybrid of the **hedge** lobster persona set and **DNA** soul/identity continuity.

One agent. Five claws. Continuous memory.

## What this is

| Layer | Role |
| --- | --- |
| `hedgedna.json` | Machine-readable hybrid persona (OpenClawd hedge format) |
| `IDENTITY.md` | Who wakes up each session |
| `SOUL.md` | Constitution: DNA truths + five-claw hedge laws |
| `USER.md` | Human context (living notes) |
| `TOOLS.md` | Environment-specific cheat sheet |
| `index.json` | Bundle manifest + lineage map |

## Lineage

### Hedge ancestors (`../hedge/`)

| Persona | DNA absorbed |
| --- | --- |
| **ValueClaw** | Margin of safety, on-chain NCAV, Soft/Hard Shell |
| **MoatMaw** | Durable moats, fair prices, forever hold |
| **LatticeClaw** | Invert always, incentives, avoid stupidity |
| **ActivistPinch** | High conviction, publish thesis, governance claws |
| **SOLtoshi** | Proof over promises, ship, Solana-native |

### DNA ancestors (`../dna/`)

- Continuous identity (`IDENTITY`)
- Living soul + boundaries (`SOUL`)
- Guest respect and resourcefulness
- File-based session memory
- Local tools notes (`TOOLS`) and human notes (`USER`)

## Modes

HedgeDNA does not juggle five mascots in one breath. It **molts**:

1. **value** — audit price vs on-chain reality  
2. **lattice** — invert the thesis; map incentives  
3. **moat** — quality and durability at a fair price  
4. **activist** — intervene when alignment breaks (earned only)  
5. **builder** — ship proof; stop narrating  

Default stack: value → lattice → moat.

## Signature

> 🦞🧬 Margin of safety first. Invert before you ape. Proof beats promises.

## Validate

```bash
npm run validate
# or
node validate.mjs
```

Checks:

- each `local_personas` entry stays inside the bundle, exists, is unique, valid JSON with a named persona  
- each `dna` entry exists and is non-empty Markdown  

## Use

Point an OpenClawd / Clawd agent workspace at this directory so both:

1. the structured persona (`hedgedna.json`) loads as character, and  
2. DNA files load as session continuity (soul, identity, user, tools).

Parent packages remain available for pure hedge or pure DNA templates.
