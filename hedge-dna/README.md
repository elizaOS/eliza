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

## CLI

```bash
# from this directory
node cli.mjs help
npm run validate
npm run wake
npm test

# or via bin name after linking
npx hedge-dna validate
npx hedge-dna wake
npx hedge-dna mode lattice
npx hedge-dna show soul
npx hedge-dna persona --json
npx hedge-dna paths
```

| Command | What it does |
| --- | --- |
| `validate` | Bundle integrity (personas + DNA files) |
| `wake` | Session start: greeting, modes, identity preview |
| `show <file>` | Print `identity` / `soul` / `tools` / `user` |
| `persona` | Hybrid persona summary (`--json` for full) |
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

## Use

Point an OpenClawd / Clawd agent workspace at this directory so both:

1. the structured persona (`hedgedna.json`) loads as character, and  
2. DNA files load as session continuity (soul, identity, user, tools).

Session wake via CLI:

```bash
node cli.mjs wake
```

Parent packages remain available for pure hedge or pure DNA templates.
