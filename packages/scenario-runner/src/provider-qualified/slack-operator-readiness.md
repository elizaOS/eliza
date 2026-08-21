# Slack provider-canary operator readiness

The Slack operator boundary validates the offline-authorized manifest, exact
workspace and root channel, exact ingress and effect text, run nonce, and both
negative-probe definitions before network access. Its read-only observer first
authenticates a distinct principal with `auth.test`, then requires the exact
human ingress and a strictly later exact bot effect from
`conversations.history`. Raw output is private, unsigned, and always carries
`qualificationClaimed: false`.

The operator plan includes a self-hashed deployed-capability descriptor bound
to the signed run, deployment, HTTPS ingress origin, operation hash, and full
failure-probe hash set. Execution requires plain function properties for
authenticated ingress, isolated trajectory export, authenticated replay,
independent failure probes, and cleanup or reconciliation. Missing, accessor-
backed, or additional seams fail before ingress. Every receipt must echo exact
run and request hashes, preserve effect counts for replay and negative probes,
and satisfy chronology checks. Trajectory material is verified from actual
isolated run-directory bytes by `verifyScenarioTrajectories`.

The contract does not provision Slack or deployment infrastructure. A live run
still needs real workspace accounts, a deployed ingress/export service, an
independent failure-probe executor, observer key custody, and a reconciliation
system. No raw receipt becomes qualification evidence without the outer
independent signing, semantic judging, assembly, and artifact verification
flow.
