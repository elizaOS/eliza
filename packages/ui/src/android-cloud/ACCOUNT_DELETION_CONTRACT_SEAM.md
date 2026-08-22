# Android account-deletion contract seam

This directory owns only the Google Play Android consumer of the account-
deletion lifecycle. Cloud reservation, scoped credential issuance, provider
reconciliation, irreversible erasure, and the generic public deletion page are
owned outside this lane.

The last read-only owner checkpoint inspected on 2026-08-22 was
`263146a03669b2ed5c57b9b5acf24571296cc599`. It contains the proposed contract
document but no stable backend implementation commit. Until the owner publishes
that commit, `account-deletion-contract.ts` is an Android-local parser matching
the proposed wire shape. It deliberately rejects the legacy status-only DTO.

## Required server boundary

| Method | Path | Authority | Android behavior |
| --- | --- | --- | --- |
| `GET` | `/api/v1/me/account-deletion` | Ordinary account session | Read an open request before ordinary access is revoked. |
| `POST` | `/api/v1/me/account-deletion` | Recent ordinary session | Send exact `DELETE` plus `consequencesAcknowledged: true`. Do not sign out unless the response is successful and `statusAccessEstablished` is exactly `true`. |
| `GET` | `/api/v1/account-deletion/status` | Single-purpose HttpOnly lifecycle credential | Recover server-owned state after ordinary session revocation. Treat `401` and `404` as no scoped status session without exposing account existence. |
| `POST` | `/api/v1/account-deletion/cancel` | Scoped credential plus origin/CSRF enforcement | Send exact `KEEP`; render only the returned request state. |
| `POST` | `/api/v1/account-deletion/export` | Scoped credential plus origin/CSRF enforcement | Send empty JSON; render only a returned HTTPS download URL. |

Every success response contains `{ request: AccountDeletionRequestDto }`.
Reservation also contains `{ statusAccessEstablished: true }`, set only after
the durable lifecycle reservation and scoped recovery authority are committed.
The DTO must contain no user, organization, provider, email, credential,
secret, or external-resource identifiers.

## Reconciliation rule

When the dedicated owner publishes a stable contract commit:

1. compare its DTO and endpoint semantics to the Android-local parser;
2. replace the local parser with the owner's canonical exported type/parser, or
   keep a narrow Android adapter only where Capacitor transport requires it;
3. run the parser, Settings, transport, Play-policy, Gradle, manifest, DEX, and
   artifact gates;
4. perform authenticated physical acceptance only after a valid disposable
   Cloud session is supplied.

Never infer deletion from a query parameter, redirect, local-storage value,
request identifier, or successful POST alone.
