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
