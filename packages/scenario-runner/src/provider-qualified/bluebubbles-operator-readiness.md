# BlueBubbles provider-canary operator readiness

The BlueBubbles/iMessage canary is executable only through the externally
hosted operator controller. Its scenario loads `@elizaos/plugin-bluebubbles`
and deliberately does not load the native `@elizaos/plugin-imessage` connector;
both register an `imessage` surface, so loading both makes provider ownership
dependent on plugin order.

Before ingress, the operator must provide an offline-authorized manifest whose
raw operation binds the exact `chatGuid`, text, and `replyToMessageGuid: null`.
The controller then authenticates the manifest-bound HTTPS BlueBubbles origin
through `GET /api/v1/server/info?password=...`. The password is accepted only
at this private boundary and is never placed in a receipt, manifest, URL hash,
log, or error.

Execution also requires all five external capabilities up front:

- authenticated deployed ingress for the exact authorized operation;
- independent provider readback of the exact outgoing message;
- authenticated replay that echoes the signed scenario/run/nonce plus hashes
  of the original ingress, provider message, observed effect, and operation;
- independent execution of every exact immutable signed negative-probe input,
  with receipts echoing its request, scope, grant, and response hashes; and
- a freshly isolated deployed run directory and immutable scenario interval,
  which the controller passes to `verifyScenarioTrajectories` itself.

The controller refuses before ingress if any capability is absent. Boundary,
readback, replay, and probe results are strictly parsed as closed shapes. Their
timestamps must be fresh and monotonic. Arbitrary trajectory-export metadata
is rejected because only recomputed canonical artifact and stage hashes are
retained. Every returned artifact is unsigned raw source material and carries
`qualificationClaimed: false`; qualification still requires independent
observer signatures, trajectory verification, semantic judging, and offline
artifact assembly/reverification.

The BlueBubbles server runs on macOS, but the controller may run elsewhere. A
production canary origin must use HTTPS because BlueBubbles authenticates its
REST API with a password query parameter. Use an operator-owned chat, a
dedicated server/account, and a harmless unique payload. Never substitute the
native Messages database, connector memory, an action result, or agent prose
for provider readback.
