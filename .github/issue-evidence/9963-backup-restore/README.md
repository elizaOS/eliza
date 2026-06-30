# #9963 — backup→wipe→restore→identical e2e + per-component integrity manifest

This bundle delivers the **non-infra-gated local slice** the re-open comment
asked for: the issue's **stated proof-of-done** (a real backup → wipe → restore
→ identical round-trip, previously absent) and a **per-component integrity
manifest** (the maintainer's "per-component sha256 with loud fail-on-mismatch",
previously absent — restore relied only on the whole-blob GCM auth tag).

## What landed

`packages/agent/src/services/agent-export.ts`:
- **Integrity manifest** — `buildExportManifest()` digests each exported
  collection (`entities`, `memories`, `components`, `rooms`, `participants`,
  `relationships`, `worlds`, `tasks`, `logs`, `media`) as `sha256` over its
  canonical JSON + a row count, embedded in the (encrypted) payload at export.
  `verifyExportManifest()` re-derives every digest at import **before any DB
  write** and `importAgent` throws an `AgentExportError` naming the offending
  collection on mismatch. Additive + back-compat: an export with no manifest
  (older file) still imports — verification is skipped, never a hard failure.
- `canonicalize()` — deterministic, key-sorted, `undefined`-dropping JSON so a
  collection's digest is identical across the export→gzip→encrypt→decrypt→
  gunzip→`JSON.parse` round-trip.

`packages/agent/src/services/agent-export.roundtrip.test.ts` (**10 tests, all
passing** — `roundtrip-test-output.txt`):
- **The round-trip**: populate a full agent graph (1 world, 2 rooms, 3 entities,
  4 participants, 1 component, 3 memories across `messages`+`facts`, 1
  relationship, 1 task) + a content-addressed media byte → `exportAgent` to a
  real encrypted `.eliza-agent` buffer → import into a **separate, empty** store
  → assert every collection count + content round-trips (ids are intentionally
  remapped, so content is compared on stable fields; the restored agent gets a
  **new** id, no clobber).
- **Wrong password** rejects and writes nothing.
- **Integrity detector** unit tests: matching manifest verifies; a JSON
  serialize→parse round-trip still verifies (canonical, order-independent); a
  row added without updating the manifest is flagged on `memories`; a content
  edit with unchanged count is flagged on `entities`; an absent manifest is
  back-compat OK; `canonicalize` sorts keys and drops `undefined`.

The DB engine in the test is a faithful in-memory adapter implementing exactly
the methods `extractAgentData`/`restoreAgentData` call — the **thing under
test** is the export/restore + manifest logic, not the SQL engine.

## Artifacts here

| File | What it is |
|------|------------|
| `roundtrip-report.json` | A real run: export format, encrypted byte size, the full per-collection sha256 integrity manifest, the restore counts (`entities:3, memories:3, rooms:2, participants:4, …`), and that the restored agent id differs from the source. |
| `sample-backup.eliza-agent` | A real encrypted backup file produced by `exportAgent` (`ELIZA_AGENT_V1` magic, PBKDF2-600k + AES-256-GCM + gzip). |
| `roundtrip-test-output.txt` | The vitest run — 10/10 passing on a Windows host. |

Regenerate: `ELIZA_WRITE_9963_EVIDENCE=1 bun run --cwd packages/agent test -- src/services/agent-export.roundtrip.test.ts`

## Out of this slice (and why)

- **Settings backup/restore-with-verify UI + first-run-after-restore** — display-gated;
  this box's RDP desktop session is currently disconnected, so live UI capture
  isn't possible. (Backend round-trip needs no display and is what's delivered.)
- **Real-LLM post-restore recall trajectory / video** — requires a live model +
  display; deferred.
- **LifeOps auto-backup scheduler**, **cloud parity (R2 dual-target, real-image
  restore)** — scheduler-/image-gated; out of the local slice.
- **Vault** — `agent-export.ts` deliberately strips `secrets` (`Omit<Character,
  "secrets">`); this PR does not change that threat-model decision.
