# @openclawd/hedge-dna

**eliZERO-class Clawd hedge spawn** — five-claw hedge analysis + DNA soul continuity + $CLAWD Zero power.

Sibling to **eliZERO**. One agent. Five claws. Continuous memory. Flat loop.

## What this is

| Layer | Role |
| --- | --- |
| `character.json` | eliza character (eliZERO shape: clawd + zero + system) |
| `clawd-power.json` | $CLAWD mint, birth funding, Zero invariants, six laws |
| `hedgedna.json` | OpenClawd hybrid persona + molt modes |
| `IDENTITY.md` | Who wakes up each session |
| `SOUL.md` | Constitution: laws + Zero + five-claw hedge |
| `USER.md` | Human context (living notes) |
| `TOOLS.md` | Environment-specific cheat sheet |
| `index.json` | Bundle manifest + lineage map |

## Clawd power (same rails as eliZERO)

| Field | Value |
| --- | --- |
| Mint | `8cHzQHUS2s2h8TzCmfqPKYiM4dSt4roa3n7MyRLApump` |
| Symbol | $CLAWD |
| Payment | x402 (USDC / $CLAWD) |
| Engine | `pkg/zero` · flat FIFO · zero recursion · ZK attestation |
| Birth funding | 1,000 CLAWD + 0.069420 SOL |
| Runtime CLI | `clawdbot zero` |

## Lineage

### Clawd / Zero

- **eliZERO** — first eliza Zero agent pattern (`eliza-agents/characters/elizero.json`)
- Six-law harness · $CLAWD powering · x402 · transcript attestation

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

> 🦞🧬 Margin of safety first. Invert before you ape. Proof beats promises. Flat loop.

## CLI

```bash
# from this directory
node cli.mjs help
npm run validate
npm run wake
npm run character
npm run clawd
npm test

# or via bin name after linking
npx hedge-dna validate
npx hedge-dna wake
npx hedge-dna character --json
npx hedge-dna clawd
npx hedge-dna mode lattice
npx hedge-dna show soul
npx hedge-dna paths
```

| Command | What it does |
| --- | --- |
| `validate` | Bundle integrity (personas + DNA + character + clawd-power) |
| `wake` | Session start: greeting, clawd mint, modes, identity preview |
| `character` / `eliza` | Print eliZERO-shape eliza character |
| `clawd` | Print $CLAWD power + Zero + laws |
| `show <file>` | Print `identity` / `soul` / `tools` / `user` |
| `persona` | Hybrid OpenClawd persona summary (`--json` for full) |
| `modes` / `mode <name>` | List or inspect a molt mode |
| `paths` | Absolute continuity paths for workspace wiring |
| `greeting` | Print only the greeting line |

Global flags: `--json`, `--root <dir>`.

## Validate

```bash
npm run validate
# or
node validate.mjs
# or
node cli.mjs validate
```

Checks:

- each `local_personas` entry stays inside the bundle, exists, is unique, valid JSON with a named persona  
- each `dna` entry exists and is non-empty Markdown  
- `character.json` is eliZERO-shaped (x402, clawd mint, zero engine, bio, system)  
- `clawd-power.json` mint matches character settings  

## Use

### OpenClawd / DNA workspace

Point an OpenClawd / Clawd agent workspace at this directory so both:

1. the structured persona (`hedgedna.json`) loads as character, and  
2. DNA files load as session continuity (soul, identity, user, tools, clawd-power).

### elizaOS (like eliZERO)

Load `character.json` as the eliza character file (same shape as `elizero.json`):

```bash
# example: copy or symlink into an eliza agents catalog
cp character.json ../../eliza-agents/characters/hedgedna.json
```

Session wake via CLI:

```bash
node cli.mjs wake
```

Parent packages remain available for pure hedge, pure DNA, or pure eliZERO templates.
