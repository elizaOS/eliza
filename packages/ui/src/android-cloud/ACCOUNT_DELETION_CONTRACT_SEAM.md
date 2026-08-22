# Android account-deletion contract seam

This directory owns only the Google Play Android consumer of the account-
deletion lifecycle. Cloud reservation, provider reconciliation, irreversible
erasure, and the generic public deletion page remain outside this lane.

The authoritative contract inspected read-only is the account-deletion owner's
stable provisioning-fence checkpoint
`e6f002fd2eaeecdbee031ba75d63ba32844a3afe`. Later committed descendants
observed through `3cf64cf3f554178cc7585ef64a04f6b55d709b43` do not change the
shared lifecycle type, service mapping, authenticated route, public
status/cancel route, or public export route. Concurrent uncommitted backend
work is excluded from this compatibility claim. No backend or public-page file
is copied or modified here.

## Stable server boundary

| Method | Path | Authority | Android behavior |
| --- | --- | --- | --- |
| `GET` | `/api/v1/me/account-deletion` | Recent ordinary bearer session | Read an existing open request while ordinary authentication remains usable. |
| `POST` | `/api/v1/me/account-deletion` | Recent ordinary bearer session | Send exact `DELETE`; accept only a valid request plus two distinct 43-character capabilities. |
| `GET` | `/api/public/account-deletion` | `X-Account-Deletion-Status` | Read identifier-minimal server state after ordinary access is revoked. |
| `DELETE` | `/api/public/account-deletion` | `X-Account-Deletion-Recovery` | Send exact `CANCEL DELETION`; trust only the returned request DTO. |
| `POST` | `/api/public/account-deletion/export` | `X-Account-Deletion-Recovery` | Send exact `EXPORT MY DATA`; stream the verified JSON bytes into Android's standard document picker. |

Initial acceptance returns
`{ request, statusCredential, recoveryCredential }`. Android validates both
opaque capabilities, stores them in separate Android Keystore-backed
namespaces, reads both back, and only then reports reservation success. If
secure persistence fails, it uses the still-in-memory recovery capability to
attempt immediate cancellation, retains only the read-only status capability
in volatile process memory when needed, and reports the exact server state
instead of pretending the account remains unchanged. Android treats
`canceling` as fenced and nonterminal; it never reports restored access until
the server returns terminal `canceled` with `accessState: active`.

The public status capability is read-only. The separate recovery capability is
required for cancellation and export and is never placed in a URL, query
parameter, log, local storage, Preferences, or artifact. Every mutating native
request uses the canonical paired Eliza API/app origins and disables redirects.

## Stable DTO consumed by Android

The runtime parser accepts only the owner's `AccountDeletionStatusDto` shape:

- status: `reserved`, `recovery`, `canceling`, `scheduled`, `processing`,
  `completed`, `canceled`, or `action_required`;
- server-owned access state: `fenced`, `active`, or `erased`;
- recovery, scheduling, irreversible, and completion timestamps;
- server-owned `canCancel` and `nextAction` values;
- optional export state: `pending`, `building`, `ready`, `expired`, `deleted`,
  or `failed`, with a verified SHA-256 content digest when present.

The former draft `phase`, `canExport`, `nextPollAfterMs`, progress, download URL,
HttpOnly-cookie, `KEEP`, and `statusAccessEstablished` assumptions are rejected.
Android polls nonterminal status on a bounded five-second UI timer; the server
remains authoritative. It requires the exact status/access/cancellation/action
combinations emitted by the owner checkpoint. In particular, `canceling` is
`fenced` with `wait_for_reconciliation`; only terminal `canceled` is `active`
with `none`. Restored access still requires a fresh sign-in because existing
sessions and API keys remain revoked.

## Export implementation

Capacitor's native HTTP bridge parses `application/json` bodies instead of
preserving the exact bytes even when `arraybuffer` is requested. The Play
projection therefore generates a narrow `ElizaPlayExport` plugin that:

1. accepts only the production or staging canonical API/app-origin pair;
2. sends the recovery capability only in the required header over HTTPS;
3. rejects redirects, non-200 results, missing or invalid digest evidence, and
   payloads over the backend's 32 MiB maximum;
4. verifies `X-Account-Deletion-Export-SHA256` in constant time;
5. asks the user where to save through `ACTION_CREATE_DOCUMENT`, which requires
   no broad storage permission; and
6. zeroes the in-memory plaintext export after saving or cancellation.

## Remaining integration gate

Checkpoint `e6f002fd2e` is the stable owner handoff; committed descendants
through observed `3cf64cf3f5` are wire- and service-mapping-compatible by exact
blob/diff comparison. Android authenticated and physical acceptance still
requires this contract in an isolated Cloud environment. Never infer deletion,
cancellation completion, restored access, or export success from a redirect,
query parameter, local value, receipt ID, or successful request alone.
