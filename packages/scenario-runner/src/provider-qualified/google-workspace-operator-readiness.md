# Google Workspace provider-canary operator readiness

The shared Google Workspace controller covers Gmail send, Google Calendar
event creation, and Google Drive/Sheets spreadsheet creation. It does not hold
OAuth credentials, bypass deployed ingress, sign observer evidence, or claim
that any provider canary has run. Every raw receipt remains unsigned and sets
`qualificationClaimed: false`.

Before credential access, the operator must supply an offline Ed25519-authorized
manifest and an exact plan, account, connection, run nonce, target, operation,
and two negative-probe inputs. The required protected capabilities must then:

1. prove the account has the exact Gmail, Calendar, or Drive write capability;
2. send the validated operation through authenticated deployed ingress;
3. collect independent provider readback for the resulting resource;
4. replay using the exact scenario/run/nonce and hashes of the original ingress,
   provider resource, observed effect, and operation, without changing state;
5. execute immutable copies of the exact validated failure-probe material and
   return the signed request, scope, and grant hashes plus a response hash; and
6. return the freshly isolated deployed run directory and immutable scenario
   interval so the controller itself can call `verifyScenarioTrajectories`.

Credential, ingress, readback, replay, and failure-probe receipts must form a
fresh monotonic interval. The independently verified trajectory interval must
also be fresh and monotonic. Caller-selected export IDs, counts, or digests are
not accepted as trajectory evidence.

The direct `GoogleWorkspaceService` adapter is only a typed production method
mapping for use behind authenticated ingress. Calling it directly is not an
evidence boundary. Provider qualification still requires real isolated Google
accounts, independent observer and semantic-judge signatures, complete signed
evidence, cleanup, artifact assembly, and offline reverification. Until that
external flow is executed, the production qualification count remains zero.
