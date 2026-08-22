# Linux remote-control target

The Electrobun Linux app can enroll itself as an account-owned remote target,
activate a controller session with the six-digit pairing code, and process
opaque Cloud relay commands without giving Cloud access to command plaintext.

## Native trust boundary

Enrollment runs in the Electrobun main process. The owner access token is used
only for the enrollment request and owner/host confirmation. The one-time host
bearer returned by Cloud is written directly to the Linux Secret Service with
the target's private P-256 signing and encryption keys. None of those values is
returned to the renderer, placed in a URL, or written to the durable journal.

The native client accepts HTTPS Cloud API bases. Plain HTTP is accepted only
for explicit loopback development. URLs containing credentials, query strings,
or fragments are rejected. Requests have a ten-second deadline and response
bodies are streamed into a one-MiB bound. Host enrollment recovery first lists
the authenticated owner's hosts and requests credential rotation only when the
device id, name, platform, connection mode, key id, and both public JWKs match
exactly.

## Command lifecycle

Activation installs the Cloud-returned owner, grant, revision, controller
identity, target identity, and expiry in the atomic local journal. Every claim
is decrypted and checked against that material before replay state changes.
The local journal requires contiguous sequence numbers, one-use nonces, bounded
sessions and commands, and a matching current grant revision.

Execution uses these durable phases:

1. `reserved`: authenticated and replay-consumed; retry is safe.
2. `started`, start not acknowledged: resend the identical start envelope.
3. `started`, start acknowledged, effect not dispatched: resume safely.
4. `started`, effect dispatched: a restart produces
   `execution_ambiguous`; the effect is never automatically repeated.
5. terminal result persisted: resend the identical encrypted result until the
   relay acknowledges it or reports a terminal claim outcome.

The target has no generic shell, filesystem, URL, or HTTP proxy. The shared
controller/target allowlist admits readiness plus the minimum selected-runtime
conversation surface: exact health/status and conversation-list GETs,
conversation creation, UUID-scoped bounded history reads, and UUID-scoped
SSE-compatible message sends buffered into the signed terminal result. Methods,
query parameters, headers, JSON fields, metadata depth/nodes, and
request/response bytes are bounded at both ends.
Chat sends require the app's durable `clientMessageId`, so the agent's
idempotency store and the remote runner's no-retry-after-start boundary compose
instead of permitting a duplicated turn. Attachments, deletion, arbitrary
plugin routes, caller authorization headers, and every other action remain
rejected before loopback. The native executor injects the real loopback bearer
and an execution id after validation.

## Revocation and cleanup

Session revocation fences the grant revision, clears replay nonces, rejects
reserved work, and turns dispatched work into explicit ambiguity. Host removal
is Cloud-first: after the owner has revoked the Cloud host, the native finalize
operation stops polling, atomically empties the journal, and deletes the Linux
Secret Service record. A failed local cleanup remains safe because Cloud
authority is already gone and the operation is idempotent for retry.

## Evidence boundary

Focused tests use real P-256 signatures, ECDH/HKDF/AES-GCM envelopes, durable
runner recreation, streamed HTTP bodies, and an in-memory OS-store substitute.
They prove protocol and crash-state behavior, not a live Cloud deployment or a
physical second device. A production demo still requires deployed migrations,
two signed-in devices, a real Secret Service session, and observed loopback
health execution through the packaged Linux app.
