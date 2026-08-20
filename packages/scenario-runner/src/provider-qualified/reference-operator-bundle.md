# Reference provider operator bundle

This reference bundle is the supported adapter between the authorization-first
`eliza-provider-canary` CLI and deployment-owned controller, observer, semantic
judge, cleanup, and secret-broker services. It covers the exact 13 scenarios in
the repository controller registry. It does not contain provider credentials,
signer private keys, provider accounts, or evidence.

## Build and pin

Use the repository-pinned Bun version from a reviewed checkout:

```bash
cd packages/scenario-runner
bun scripts/build-reference-operator-bundle.ts \
  --out /secure/operator/provider-capabilities.mjs \
  --template-out /secure/operator/reference-operator-config.json
```

The command refuses to overwrite either output, builds one ESM file, and fails
if that file retains a relative or non-Node import. It prints the bundle's
SHA-256 for `operatorModuleSha256`. The external canary loader verifies those
exact bytes and imports them through a data URL only after signed authorization
preflight. A digest is integrity, not a JavaScript sandbox; review the built
file and protect its path.

The generated configuration is intentionally non-runnable. Replace every
example endpoint, organization, public key, key ID, identity hash, and secret
reference. Keep the file owned by the canary user with mode `0600`, set
`ELIZA_PROVIDER_OPERATOR_CONFIG_FILE` to its absolute path, and do not put a
token or provider input in it.

## Trust and credential boundaries

Factory invocation receives only the signed-preflight correlation
`scenarioId`, `operationKind`, `runId`, and `manifestSha256`. Before resolving a
secret, the bundle:

1. rejects accessors and unknown factory fields;
2. validates all 13 deployment records, not only the selected record;
3. compares every scenario, operation, and controller family with the canonical
   registry;
4. requires credential-free HTTPS endpoints with explicit paths;
5. requires controller, observer, judge, and cleanup origins and administrative
   domains to be distinct, including from the declared manifest-authority
   organization; and
6. binds the observer and judge evaluator to the same exact endpoint,
   organization, bearer credential, public key, and service identity that signs
   its evidence; and
7. requires the separately operated cleanup endpoint to sign its proof with the
   exact authorized observer key rather than a self-declared cleanup key.

The last rule prevents a generic signer from becoming a blind signing oracle:
there is no separate evaluator-to-signer seam in the configuration. The outer
CLI remains responsible for cryptographically validating the signed manifest
authority pin; its factory input deliberately exposes no authority private
material or credential.

Only then does the bundle request the four selected bearer values (controller,
observer, judge, cleanup) from `secretBrokerEndpoint`. The broker request uses
the token in `ELIZA_PROVIDER_OPERATOR_SECRET_BROKER_TOKEN`, which is read only
during factory invocation. The response must have the exact shape below and
echo the nonce:

```json
{
  "schema": "eliza.provider-canary-secret-response.v1",
  "requestNonce": "the-exact-request-nonce",
  "values": {
    "the/requested/secret-ref": "the-resolved-bearer-value"
  }
}
```

The values object must contain exactly the requested refs. Responses containing
PEM private-key markers are refused. A production secret broker should also
bind its workload identity and authorization policy to the exact refs; the
bearer transport is not a substitute for broker-side authorization.

## Service protocol

Controller execution, observation begin/complete, semantic evaluation, and
cleanup use the same correlated request envelope:

```json
{
  "schema": "eliza.provider-canary-service-request.v1",
  "role": "controller-execute",
  "requestNonce": "random-base64url",
  "manifestSha256": "...",
  "runId": "...",
  "scenarioId": "provider.gmail.confirmed-send",
  "operationKind": "gmail.email-send",
  "payload": {}
}
```

The service returns HTTP 200 `application/json`, never a redirect, with:

```json
{
  "schema": "eliza.provider-canary-service-response.v1",
  "role": "controller-execute",
  "requestNonce": "the-exact-request-nonce",
  "requestSha256": "sha256-of-canonical-request-json",
  "result": {}
}
```

Supported roles are `controller-execute`, `observer-begin`,
`observer-complete`, `semantic-judge-evaluate`, and `cleanup-and-sign`.
Observer and judge evidence signing calls use the separately documented remote
evidence signing schema on the same respective endpoint. Each downstream
result is still verified by the controller-orchestrator bridge: a correlated
HTTP response alone cannot qualify a canary.

The controller service selects its raw adapter from the request's canonical
scenario/operation/controller-family contract. BlueBubbles, Duffel, Google
Workspace, and messaging return their closed raw receipts; Discord, Slack, and
Twilio return the deployed-composite receipt containing a verified deployed
execution. Missing trajectories, readback, replay, failure probes, cleanup, or
provider seams fail during bridge validation and cannot be relabeled as
qualification.

## Operational rules

- Run each canary with an isolated provider account and state directory.
- Never put a bearer token, OAuth refresh token, private key, raw target, or
  operation input in configuration, command arguments, logs, or the bundle.
- Do not colocate controller, observer, judge, cleanup, or manifest-authority
  administration merely because their endpoints are distinct.
- Treat an ambiguous provider effect or cleanup reconciliation response as a
  terminal manual-reconciliation condition. Do not retry it automatically.
- Keep the PR draft until all 13 real-provider capsules pass offline
  reverification and the canonical catalog gate.
