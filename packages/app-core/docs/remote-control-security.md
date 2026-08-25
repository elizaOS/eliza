# Remote control security and execution contract

This document specifies the transport-independent security boundary used when
one account-owned device controls an Eliza runtime. A Cloud mailbox, managed
network, LAN path, or loopback SSH tunnel may carry the same envelope. None of
those transports is an authorization boundary.

The shared wire types live in
`@elizaos/shared/contracts/remote-control`. Node-compatible cryptography and the
reference durable command journal live in `@elizaos/app-core/security`.

## Principals and binding

Every command, start receipt, result, and encrypted-envelope AAD repeats the
same immutable binding:

- `ownerId`: authenticated account owner;
- `grantId` and `grantRevision`: exact authority snapshot;
- `sessionId`: one bounded pairing/control session;
- `controllerDeviceId` and `controllerKeyId`: controlling device and its key
  bundle;
- `targetRuntimeId` and `targetKeyId`: selected runtime and its key bundle; and
- `commandId`: the durable idempotency identity.

The signed command also binds its monotonic `sequence`, one-use `nonce`, issue
and expiry times, action, and canonical payload digest. Command envelopes repeat
`sequence`, `nonce`, `issuedAt`, and `expiresAt` as authenticated routing fields
so a relay can transactionally reject obvious replay/order violations without
decrypting. A relay cannot retarget ciphertext by changing a cleartext routing
field because all routing fields are authenticated as AES-GCM additional data
and must match the decrypted signed body exactly.

Controllers and targets use separate P-256 signing and encryption key pairs.
Private keys belong in platform secure storage. They are not relay payloads,
browser storage, logs, pairing records, or UI state. V1 uses ECDSA P-256/SHA-256
for signatures and ephemeral P-256 ECDH, HKDF-SHA-256, and AES-256-GCM for each
recipient-bound envelope.

## Admission ordering

Cryptographic verification is deliberately split from durable admission:

1. Parse the bounded shared wire contract.
2. Check owner, grant, revision, session, controller, target, and target-key
   bindings against the selected identities and grant.
3. Reject revoked or expired authority.
4. Check issue time, expiry, maximum TTL, payload digest, and controller
   signature.
5. Call `DurableRemoteCommandJournal.authorizeAndReserve`.
6. Inside one durable transaction, re-read and lock the current grant/session,
   re-check revision/revocation/expiry and all bindings, check the existing
   command ID, consume nonce and sequence, and insert the reserved journal row.

Step 5 must never be replaced by a standalone replay-cache write. A static
grant snapshot can become revoked between steps 3 and 5. The durable adapter is
therefore responsible for serializing grant revocation, session termination,
replay consumption, and reservation. A relational implementation should lock
in this order: grant, session replay cursor, command journal row. Every path
uses the same order to avoid deadlocks.

An identical `commandId` and digest returns the existing record. Reusing a
command ID with different signed bytes is a conflict. A fresh command with a
used nonce or non-increasing sequence is a replay. Nonces expire only after the
command's accepted expiry and the sequence high-water mark remains for the
session lifetime. Live replay entries are never evicted to make space: the
session fails closed at its configured capacity. Session termination deletes
its replay state and fences every nonterminal record.

## Durable execution state machine

```text
verified + authorized
        |
        v
    reserved  -- durable start receipt -->  started
        |                                    |
        | session ends                       | result committed
        v                                    v
    rejected                   completed | rejected | cancelled
                                             |
                                             | restart/session termination
                                             v
                                  execution_ambiguous
```

`reserved` means a retry is safe because the external effect has not started.
The target writes `executionId` and `startedAt` durably before it invokes the
effect. A duplicate request for a `started` record never invokes the effect
again. On recovery, every orphaned `started` record is transitioned to
`execution_ambiguous`; it is not automatically replayed.

`executeReservedRemoteCommand` implements this ordering. If the effect throws
after the start receipt, the helper records `execution_ambiguous`, because an
exception cannot prove whether another system committed its side effect. The
explicit ambiguity is a security and correctness outcome, not a generic error
to retry.

The journal guarantees exactly-once **dispatch** for a command ID. A business
effect stored in another database is exactly-once only when that system also
persists `executionId` as a unique idempotency key, or when its write and the
journal completion share a transaction. Without one of those integrations no
process can distinguish “effect committed, completion write crashed” from
“effect never committed”; the protocol reports ambiguity instead of making an
unsafe claim or duplicate attempt.

## Results

A start receipt is signed by `targetKeyId` and contains the command digest,
execution ID, and start time. A terminal result repeats the complete command
binding, command digest, execution identity/times, status, and a digest of the
result/error pair. The controller verifies the target identity, every original
command field, both digests, and the target signature before displaying or
acting on a result.

`execution_ambiguous` is terminal for automatic processing. A user or a
domain-specific reconciliation workflow may inspect the target and issue a new
command with a new command ID, but the original effect is never automatically
replayed.

## Pairing and revocation boundary

Pairing activation must create one controller key binding and one active grant
in a failure-atomic operation. Pairing codes are one-use, short-lived,
owner/target/purpose bound verifiers; they are not bearer credentials. A grant
cannot be activated until the controller and target public-key bundles are
fixed. Re-enrollment rotates key IDs and creates a new session/grant rather
than silently changing an active binding.

Revocation increments the grant revision and is serialized with command claim
and start. Session termination revokes its active grants, rejects reserved
commands, marks started commands ambiguous, and deletes replay state. Removing
a managed-network node, access token, profile, or tunnel is compensation around
that authority change; failure to clean a transport must not restore command
authority.

## Adapter requirements

A production durable-journal adapter must preserve all semantics demonstrated
by `InMemoryDurableRemoteCommandJournal` and its adversarial tests:

- concurrent same-sequence claims admit at most one command;
- revocation is checked in the reservation transaction before replay state is
  consumed;
- an identical pre-start retry returns the reserved record;
- post-start recovery returns `execution_ambiguous` without invoking the
  effect;
- duplicate identical completion is idempotent while a conflicting result is
  rejected;
- termination clears bounded replay state and fences nonterminal records; and
- journal, grant, and replay retention have explicit expiry/pruning policies.

Cloud relays store only the opaque encrypted envelope plus routing metadata.
They must validate the shared envelope shape and account/session ownership, but
they do not decrypt messages and must not infer execution success from mailbox
delivery.

## SSH gateway and remote-host custody

The remote Eliza API listens only on `127.0.0.1:2138`. The Mac gateway forwards
only the allowlisted agent API path and strips renderer-supplied authorization
and forwarded-host headers; settings and arbitrary local APIs are denied.

A `SHA256:` SSH host fingerprint verified through an independent channel is
mandatory. There is no trust-on-first-use fallback, and a changed host key is
rejected. Private keys remain in the Mac secure store and are never copied to
the controller phone, Cloud, lifecycle receipts, logs, or managed-network
records.

SSH setup and removal are serialized and restart-safe. Public lifecycle
receipts contain only the version, profile identifier, phase, and timestamps
needed to resume cleanup. They never contain a private key path, credential,
fingerprint, or target address. An active profile cannot be removed underneath
a running tunnel.

## Managed-network compensation

This is an opt-in server-side infrastructure contract. The current native
Devices flow neither requests nor consumes a Headscale credential, so the
product does not claim managed-network enrollment until a reviewed native
lifecycle exists. The committed v0.28 policy declares
`tag:eliza-remote-host` and permits it to reach only
`tag:eliza-proxy:443`; it has no edge to agents, peer remote hosts, or from the
proxy back to the host.

Headscale configuration accepts HTTPS endpoints, or loopback HTTP for local
tests only. Pre-auth keys are one-use, non-ephemeral, tagged, and limited to 15
minutes. Only the numeric pre-auth key identifier and cleanup status are stored;
the secret key is not persisted.

Database success followed by Headscale failure revokes host authority and
records retryable compensation. Repeated cleanup, missing keys or nodes, and
process restart are idempotent. Transport cleanup can lag without restoring
revoked command authority. Idempotent absence is recognized only from a typed
HTTP 404, never by matching digits in an error message. Database diagnostics
are explicitly marked bounded previews; complete upstream bodies remain in
protected logs.

## Evidence boundary

Mocks, PGlite, disposable PostgreSQL or `sshd`, Simulator, an HTTP health check,
and a successful build each prove a distinct local boundary. None proves a
deployed isolated tenant, real Headscale compensation, signing, a physical
phone, a second Mac, or a user VPS. Native port 50001 belongs to the separate
macOS candidate and is outside this lane.
