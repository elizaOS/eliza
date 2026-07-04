# #13406 — `/dashboard/my-agents` HTTP 500 on `POST /api/my-agents/claim-affiliate-characters`

Repro + fix evidence, captured against the real e2e harness (`wrangler dev` Worker +
PGlite bridge via `packages/cloud/api/test/e2e/run-e2e-batches.mjs`) — the same stack
the CI e2e lane runs.

## Root cause

The Worker bundles `packages/cloud/api/src/stubs/elizaos-plugin-sql.ts` in place of
`@elizaos/plugin-sql` (`wrangler.toml` `alias`). The stub's `rooms` table was stale:
it still declared `server_id`, but the real plugin-sql schema (which the cloud
migrations were generated from) renamed that column to `message_server_id` (and added
`name`). `roomsRepository.findByIds` does `dbRead.select().from(roomTable)`, so inside
the deployed Worker it emits:

```
select "id", "agent_id", "source", "type", "server_id", "world_id", "channel_id",
       "metadata", "created_at" from "rooms" where "rooms"."id" in ($1)
```

→ Postgres 42703 (`column "server_id" does not exist`) → route catch →
`failureResponse` classifies the driver error as infrastructure → **500** for every
signed-in user with ≥1 `participants` row (i.e. anyone who ever chatted), which is
exactly the `/dashboard/my-agents` page-load claim call.

Same drift class fixed in the stub for `worlds.server_id` / `channels.server_id`
(→ `message_server_id`) and `channel_participants.user_id` (→ `entity_id`).

## BEFORE (fix reverted / develop) — request → 500

New e2e test (`group-c-agents.test.ts`, session cookie + the exact page-load POST):

```
(fail) /api/my-agents/claim-affiliate-characters > POST with a session cookie claims
       an affiliate character the user chatted with [44.74ms]
error: body: {"success":false,"error":"An unexpected error occurred","code":"internal_error"}
Expected: 200
Received: 500
 83 pass
 1 fail
```

Worker structured log at the moment of the request:

```
<-- POST /api/my-agents/claim-affiliate-characters
✘ [ERROR] [Claim Affiliate Chars] Error: Error: Failed query: select "id", "agent_id",
  "source", "type", "server_id", "world_id", "channel_id", "metadata", "created_at"
  from "rooms" where "rooms"."id" in ($1)
      at async RoomsRepository.findByIds (packages/cloud/shared/src/db/repositories/agents/rooms.ts:91:21)
--> POST /api/my-agents/claim-affiliate-characters 500 8ms
```

## AFTER (stub fixed) — request → 200, claim executes

```
<-- POST /api/my-agents/claim-affiliate-characters
--> POST /api/my-agents/claim-affiliate-characters 200 5ms    (no rooms → {success:true, claimed:[]})
<-- POST /api/my-agents/claim-affiliate-characters
--> POST /api/my-agents/claim-affiliate-characters 200 22ms   (seeded affiliate room → character claimed)
 84 pass
 0 fail
```

The seeded test also asserts the domain artifact directly in the DB after the claim:
`user_characters.user_id` / `organization_id` flipped from the anonymous affiliate
owner to the claiming user + org (gated ≠ owned, ownership transfer verified on the
row, not the response).

## Mutation check

Reverting only the stub fix and re-running the suite reds the new test with the exact
original failure (`83 pass / 1 fail`, same `server_id` failed query + 500); restoring
the fix goes green (`84 pass / 0 fail`).

## Gates

- `E2E_ONLY=group-c bun run --cwd packages/cloud/api test:e2e` → 84 pass / 0 fail
- `bun run --cwd packages/cloud/api typecheck` → clean
- `bun run --cwd packages/cloud/api lint` → clean (850 files, no fixes)
- `bun run --cwd packages/cloud/api test` → 133/136 files pass; the 3 failing files
  (`compat-agent-credit-gate`, `eliza-agents-create-idempotency`,
  `messages-iac-fast-path`) fail identically on clean `origin/develop`
  (pre-existing missing exports in cloud-shared, unrelated to this change).
