# Secure remote runtime relay

This slice gives the Cloud control plane a narrow role in Devices & Runtimes:
it enrolls revocable tenant-owned host identities, consumes one short-lived
pairing challenge, and relays structurally validated encrypted envelopes. Cloud
never receives a private key or plaintext command/result body.

## Authority model

- Every host row is scoped by organization and authenticated owner. Enrollment
  stores only public P-256 keys and the SHA-256 digest of a 256-bit bearer token.
- A host session binds one owner, grant id/revision, controller device/key,
  target runtime/key, and expiry. Pairing verifiers bind the same tenant, owner,
  host, and session identities and are cleared atomically on first use.
- Command envelopes repeat that complete scope as authenticated AAD. Cloud uses
  only the strict shared protocol parser and does not decrypt or rewrite the
  ciphertext.
- Sequence, nonce, command id, issue time, and expiry come from authenticated
  command-envelope AAD. Unique database indexes and a locked contiguous
  sequence cursor provide idempotency/replay rejection. One session is capped
  at the shared 4,096-entry replay bound; a controller must pair a new session
  afterward.

## Lock and lifecycle invariants

Every relay mutation takes PostgreSQL row locks in one order:

1. host;
2. session;
3. command.

Session or host revocation therefore serializes with enqueue, claim, start, and
complete. Cleanup is bounded to 500 commands and 100 sessions per transaction;
an idempotent repeated revoke drains another page while the already-revoked
host prevents new work. Natural grant expiry uses the same 500-command page:
pre-start work expires, started work becomes ambiguous, and later owner or host
requests continue draining without reopening the session.

The command lifecycle is:

```text
pending -> claimed -> started -> completed
   |          |          |
expired   pending     execution_ambiguous
   |      (lease only)   (never retried)
cancelled <- revoke -> execution_ambiguous
```

Only a `claimed` command whose lease expires before a start receipt may return
to `pending`. The target must durably sign and upload a start receipt before it
executes. After that transition, expiry, revocation, or a missing result is
`execution_ambiguous`; Cloud never automatically requeues it. Completion must
match the exact claim token, attempt number, and persisted start receipt.

## HTTP surface

- `GET|POST /api/v1/remote/hosts` (GET returns authenticated `ownerId` plus
  target public identities so a controller can create its owner-bound identity)
- `POST /api/v1/remote/hosts/:id/revoke`
- `POST /api/v1/remote/pair` with `hostId` and controller public identity
- `POST /api/v1/remote/sessions/:id/activate` with host bearer auth
- `POST /api/v1/remote/sessions/activate` with host bearer auth and a six-digit
  code; discovery is bounded to that exact host's current pending sessions
- `POST|GET /api/v1/remote/sessions/:id/commands` for owner enqueue / host claim
- `POST .../commands/:commandId/start`
- `POST .../commands/:commandId/complete`
- `GET .../commands/:commandId` for owner-scoped status/result

Host-authenticated routes require `X-Remote-Host-Id` plus
`Authorization: Bearer rhost_v1_...`. Owner routes use the existing Cloud user
or API-key organization authority.

## Evidence and explicit non-goals

Focused proof uses the real PGlite transaction engine for migration constraints,
one-use pairing, lock serialization, replay/idempotency, pre-start lease retry,
post-start ambiguity, completion fencing, and revocation cleanup. Hono route
tests cover strict input parsing, tenant scope, host authentication, and stable
failure codes.

This slice does not provision or delete Headscale/Tailscale nodes, SSH keys,
network grants, tunnels, or production infrastructure. Those external effects
need a separate compensation-owned workflow with durable intent/result records;
adding them inside these database transactions would recreate the partially
enrolled and cleanup-authority failures found in the archived implementation.
