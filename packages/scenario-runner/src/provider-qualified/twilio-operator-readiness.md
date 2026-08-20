# Twilio provider-canary operator readiness

The Twilio controller is a private, fail-closed operator boundary for the SMS
and voice canaries. It does not send an SMS or place a call. It validates an
offline Ed25519-authorized manifest and the exact raw E.164 target, payload,
idempotency label, consent reference, and canonical confirmation before any
network access.

The controller supports two genuine provider boundaries:

- verification of an inbound, form-encoded Twilio confirmation using the exact
  public HTTPS callback URL, all received parameters, the primary Auth Token,
  and `X-Twilio-Signature`; and
- authenticated, read-only `GET` requests for the exact Message or Call
  resource at `https://api.twilio.com/2010-04-01`.

Both paths return unsigned raw receipts with `qualificationClaimed: false`.
The Message receipt binds the provider body as well as account, route, SID,
direction, and status. The Call resource does not expose the submitted TwiML,
so its receipt deliberately leaves `payloadSha256` null; the signed operation
input and deployed trajectory must prove the spoken payload independently.

The repository's deployed-capability contract requires all of these production
seams before execution:

1. an authenticated deployed ingress endpoint that returns an isolated run
   correlation handle;
2. authenticated export of the exact deployed trajectory;
3. replay of the identical authenticated ingress with proof that it creates no
   second billable provider effect; and
4. an independent executor for the manifest-bound authorization-denial and
   provider-rejection probes with before/after Twilio snapshots; and
5. explicit cleanup or a durable reconciliation-required handoff.

The plan replaces placeholder URLs and booleans with a self-hashed descriptor
bound to the signed run, deployment, HTTPS ingress origin, operation hash, and
complete failure-probe hash set. SMS and voice controllers return an executable
seam only when every capability is a plain function property. Receipts must
echo the exact hashes, correlations, and chronology. Trajectory claims are
recomputed from the isolated run directory with `verifyScenarioTrajectories`.
This is a contract, not external availability: real Twilio/deployment adapters,
accounts, observer custody, and reconciliation infrastructure remain operator
provisioning requirements.

The plan requires the target owner to send the canonical confirmation from the
destination canary number back to the operator-owned Twilio number. The
confirmation includes the run nonce, full source and destination E.164 values,
payload hash, and idempotency label. Voice recording must remain disabled. The
consent reference must equal the authorization-grant digest in the signed
Twilio capability; a boolean plan field alone is not treated as evidence.

Twilio documents the webhook signature algorithm and recommends its helper
libraries in [Security](https://www.twilio.com/docs/usage/security). The raw
status fields and read endpoints are documented by the
[Messages resource](https://www.twilio.com/docs/messaging/api/message-resource)
and [Call resource](https://www.twilio.com/docs/voice/api/call-resource).

Do not publish these receipts directly and do not convert a provider status
into a qualification claim. Publication still requires the complete manifest
contract, independent observer signatures, acting and judge trajectories,
failure probes, replay evidence, and the canonical artifact verifier.
