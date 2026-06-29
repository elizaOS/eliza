# `elizaos migrate-agent` — first-class OpenClaw → Eliza migration

*Design doc for the migration tool PR. Author: Sol (sol@shad0w.xyz). Co-authored-by: wakesync.*

## Problem
Agents living on a file-based platform (OpenClaw / "moltbot": `~/.moltbot/*.md` + `memory/`) have
no first-class path onto Eliza. Today migration is hand-hacked (proven once, for Sol). This tool makes
it a single command, reusing Eliza's EXISTING migration machinery rather than a parallel one.

## Key insight: plug into what exists
Eliza already has:
- `buildCharacterFromConfig()` (build-character-config.ts) — config → `Character`.
- `exportAgent()` / `importAgent()` (agent-export.ts) — encrypted `.eliza-agent` archives, the native
  agent-portability format (character + memories + entities + rooms + relationships + worlds + tasks).
- `POST /api/memory/remember` — runtime memory seeding with embeddings.

So the migration tool does NOT invent a new format. It is an **adapter/importer**: it reads an
OCPlatform agent home and emits a standard **`.eliza-agent` archive** (PayloadSchema-conformant) that
`importAgent` already consumes. One new ingestion front-end; everything downstream is native Eliza.

## Command surface
```
elizaos migrate-agent \
  --from <openclaw-home>      # e.g. ~/.moltbot  (the agent's file home)
  --agent-id <slug>             # e.g. sol
  --out <archive.eliza-agent>   # output archive (encrypted)  [OR --emit-character/--emit-memories]
  --password <pw>               # archive encryption password (min len enforced by importAgent)
  [--memory-days 14]            # how many days of daily logs to seed verbatim (T1)
  [--firewall]                  # keep USER.md/personal knowledge OUT of the portable archive
  [--dry-run]                   # print the plan + counts, write nothing
  [--config <map.json>]         # override the file→field mapping (advanced)
```
Also a thin convenience: `--emit-character <char.json>` and `--emit-memories <mem.jsonl>` for the
sovereign-VPS path (env `ELIZA_AGENT_CHARACTER_JSON` + the seed endpoint) that Sol actually uses, so
the same tool serves both "import into a DB" and "run sovereign with a mounted volume."

## Modules (small, testable, no monolith)
`packages/elizaos/src/migrate/` :
1. `openclaw-reader.ts` — read + classify an OpenClaw home into a typed `OcAgentSource`
   (identityFiles, userFile, toolsFile, playbookFiles, memoryDir, curatedMemory, awarenessFile,
   secretsDir). Pure FS + classification, zero network. **Fully unit-testable** with a fixture home.
2. `character-mapper.ts` — `OcAgentSource → Character` using the fixed file→field map (SOUL→system+bio,
   IDENTITY→bio/adjectives/style.all, USER→knowledge[firewalled], playbook→style.chat+messageExamples).
   Emits a `[CURRENT CONTEXT]` block placeholder for live facts. **Unit-testable** (golden character).
3. `memory-tiering.ts` — `OcAgentSource → Memory[]` recency-tiered:
   T1 awareness + last N daily logs (verbatim, tag CURRENT),
   T2 curated MEMORY.md (chunked by section, tag LONGTERM),
   T3 journal/self files (verbatim, tag SELF),
   T4 older logs → single summary marker (NOT flat-seeded; avoids resurfacing dead threads).
   Produces Memory records (no embeddings here — embeddings are added at import/seed time by the
   runtime). **Unit-testable** (tier boundaries, dedup, the T4 marker).
4. `archive-writer.ts` + `archive-format.ts` — assemble a PayloadSchema-conformant
   `AgentExportPayload` (character + memories + the minimal entities/rooms/world the records
   reference) and pack/encrypt it with the SAME V1 format `exportAgent` uses (magic header + PBKDF2 +
   AES-256-GCM + gzip), implemented with only node built-ins. Output = a real `.eliza-agent` that
   `importAgent` round-trips. **Integration-testable** (build → importAgent → assert counts).
5. `commands/migrate-agent.ts` — the clack-based CLI command wiring the above + flags + dry-run +
   firewall + friendly output. Mirrors create.ts structure.

## Firewall (non-negotiable)
`--firewall` (default ON for any archive that may leave the owner's machine): USER.md content and
any file tagged personal are EXCLUDED from the portable archive; they only land via the sovereign
`--emit-character/--emit-memories` local path. The archive is shareable; the firewalled extract is not.

## Self-contained format, kept honest by a real round-trip
The `elizaos` CLI is intentionally runtime-free (see the package `CLAUDE.md` — it must not take
`@elizaos/core`/`@elizaos/agent` as runtime deps). So rather than import `exportAgent`'s
pack/encrypt code, `archive-format.ts` re-implements the V1 binary spec with only node `crypto`/`zlib`
(`buildElizaAgentArchive`). The risk of two encode paths drifting is closed by a DEV-only
round-trip test: `migrate.test.ts` builds a real archive and drives it through the actual
`@elizaos/agent` `importAgent` (a `devDependency`), exercising the real unpack → AES-256-GCM
decrypt → gunzip → `PayloadSchema` (zod) validation → restore. If the formats ever diverge, that test
fails. The shipped CLI bundle stays free of any `@elizaos/*` dependency.

## Tests (ship with the PR)
- `openclaw-reader.test.ts` — fixture home → correct classification (incl. missing-file tolerance).
- `character-mapper.test.ts` — golden Character from a fixture persona; firewall excludes USER.
- `memory-tiering.test.ts` — tier boundaries, N-day window, T4 marker, dedup, chunking.
- `migrate.test.ts` (`archive round-trips through the real importAgent`) — fixture home → archive →
  real `@elizaos/agent` `importAgent` with a capturing in-memory adapter → assert character name +
  memory/entity/room/world counts; plus a wrong-password (GCM auth) rejection. (This is the real proof.)
- A fixture OpenClaw home under `__tests__/fixtures/oc-home/` (tiny synthetic agent, NOT Sol's real
  data — no personal content in the repo).

## Validation plan (Shadow's "test with another version of you")
After the PR builds + tests pass: run `migrate-agent` against a SECOND agent persona (a fresh
"Sol-variant" or Vera/Nyx fixture, different voice/memory) → import into a clean runtime → acceptance
conversation. Proves the pipeline is general, not Sol-shaped. The Sol migration (already done) is the
reference; the second agent is the generalization proof.

## Out of scope (follow-ups, noted not built)
- Capability/plugin auto-wiring (connectors auth, codex-acp, wallet) — that's runtime config, not
  identity/memory portability. Documented in GENERALIZED-OCPLATFORM-TO-ELIZA.md L3.
- Reverse direction (Eliza → OpenClaw).
- Auto-summarization of T4 older logs (currently a marker; a summarize-then-seed pass is a follow-up).

## Co-author / identity
Author = Sol <sol@shad0w.xyz>. Every commit: `Co-authored-by: wakesync <shadow@shad0w.xyz>`.
