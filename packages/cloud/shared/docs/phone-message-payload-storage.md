# Phone message payload storage authority

`phone_message_log` is the durable row catalogue for phone payloads. Its
`message_body`, `media_urls`, `agent_response`, and `metadata` columns may be
inline or pointer-backed, but callers must read them through
`phoneMessageLogsRepository.findHydratedById(organizationId, messageLogId)`.
Each log captures an immutable `organization_id` when it is created. Repository
reads and updates predicate that historical owner directly; they never derive
authorization from the phone number's current owner. A composite database
foreign key prevents reassignment of a phone-number row once it has message
history, and an owner trigger fills legacy inserts during rollout while
rejecting mismatches or later tenant rewrites. The repository derives the only
valid object key from the immutable tenant, message id, creation date, field,
and lowercase write-generation UUID, then hydrates every pointer in strict
mode. Legacy deterministic keys are accepted for already-persisted rows only.
This includes the deterministic `.txt` keys created for serialized
`media_urls` and `metadata` before those columns became JSONB; new JSON writes
always use immutable, versioned `.json` keys. Raw inline previews and `{}` /
`[]` pointer placeholders are not payload authority.

The semantic JSON columns are:

- `agent_phone_numbers.metadata`: JSON object or `NULL`;
- `phone_message_log.media_urls`: array of strings or `NULL`;
- `phone_message_log.metadata`: JSON object or `NULL`;
- `agent_phone_contacts.metadata`: non-null JSON object;
- `phone_gateway_devices.metadata`: non-null JSON object.

New message writes validate metadata at the webhook/service boundary. Valid
large values use the existing object pointer columns; invalid values fail and
are never rewritten as an empty object. Object-store failures, missing bodies,
malformed JSON, invalid hydrated shapes, unknown storage modes, stale inline
keys, and tenant/key mismatches are explicit typed failures.
The canonical readers for `agent_phone_numbers.metadata`,
`agent_phone_contacts.metadata`, `phone_gateway_devices.metadata`, and inline
`phone_message_log.metadata` select JSONB as `::text` before the SQL driver can
decode it, then parse and validate the object with source-aware JSON numbers.
Runtime code that does not need metadata must omit the column from its SQL
projection. Numbers that cannot round-trip through a JavaScript `number` remain
standards-backed `JSON.rawJSON` leaves, so response serialization preserves
their exact PostgreSQL numeric value instead of producing `Infinity`, zero, or
a rounded integer.

Every new object key is immutable and create-only. Response updates upload a
new generation without a database lock, then use a tenant-scoped SQL compare
and swap against the prior pointer/value. Concurrent losers and SQL failures
can leave an unreferenced generation for lifecycle cleanup, but cannot replace
the authoritative object or hydrate another writer's body.

This storage migration deliberately leaves WhatsApp delivery, replay, and
idempotency behavior unchanged. Canonical storage failures are typed and
bounded at the repository/service boundary, but this change does not claim an
exactly-once provider contract or a durable receipt/outbox. That broader
provider boundary remains outside #22984 under the #22359 overlap fence.

The administrative database copy follows the same phone-key rule and finishes
external object writes before opening its destination SQL transaction. It
binds the original JSON text directly as `::jsonb`, so large integer and decimal
lexemes never pass through JavaScript number serialization. Legacy sources
derive the new log owner from the joined phone-number row; modern sources must
carry the same immutable owner as that row or the copy fails before SQL or R2
writes.

## Mixed-version rollout

The JSONB migration and the final application revision are a fenced rollout,
not independently deployable changes. The final code intentionally contains no
runtime `CREATE TABLE`, text serialization, or `metadata::jsonb` compatibility
path.

1. Rebase and allocate the next unoccupied migration number immediately before
   publication. Run the malformed/wrong-shape and tenant-key preflight against
   a production snapshot; any rejected row stops the rollout for manual repair.
   Legacy inline-only logs cannot prove a former tenant after a historical
   reassignment, so audit number ownership before accepting the current-owner
   backfill.
2. Quiesce phone-gateway registration/authentication and phone-message writes
   for the short schema transition. Do not deploy this application revision
   against the legacy `TEXT` schema.
3. Apply the transactional, idempotent conversion and constraints. A failed
   conversion rolls back all five columns; never continue to application
   deployment after a migration failure.
4. Deploy the exact application revision, restore traffic, then verify one
   inline read, one pointer-backed read, and BlueBubbles authentication without
   sending a provider message. Roll back the application and schema together
   if verification fails.

No production backfill, R2 mutation, provider delivery, or deployment is
performed by the repository tests or migration tooling in this change.
