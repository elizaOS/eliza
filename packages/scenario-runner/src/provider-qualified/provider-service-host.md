# Provider canary service host

The service-host SDK is the deployment half of the reference operator bundle.
It exposes closed, authenticated HTTPS boundaries for controller execution,
independent observation, independent semantic judgment, cleanup, cleanup
attestation, and secret resolution. It contains no provider implementation,
credential, signing private key, account, or evidence.

## Deployment topology

Deploy each administrative role independently. Distinct DNS names alone do not
establish independence; use separate workload identities, policy owners,
credential stores, state directories, and audit sinks.

| Service administration | Allowed roles | Sensitive authority |
| --- | --- | --- |
| Controller | `controller-execute` | Exact provider operation and deployed scenario execution |
| Observer | `observer-begin`, `observer-complete`, `observer-sign`, `observer-cleanup-sign` | Read-only provider/durable-state observation and observer HSM key |
| Semantic judge | `semantic-judge-evaluate`, `semantic-judge-sign` | Independent model evaluation and judge HSM key |
| Cleanup operator | `cleanup-execute` | Provider cleanup only; **no observer key** |
| Secret broker | `secret-resolve` | Exact selected bearer-secret references only |

The cleanup split is mandatory. `cleanup-execute` returns an unsigned,
correlated `eliza.provider-canary-cleanup-result.v1` result and durably records
it. The observer then receives that result at `observer-cleanup-sign`,
independently re-queries cleanup/provider state, constructs the canonical proof,
and signs with its own HSM. Never grant the cleanup administration access to
the observer key.

## Server construction

`createProviderCanaryServiceHost` returns a Fetch-compatible handler. Put it
behind an HTTPS ingress that preserves the exact path, or use
`createProviderCanaryHttpsServer` with reviewed TLS options. The latter keeps
the TLS key in the service process; evidence private keys still remain behind
`ProviderServiceEd25519Signer` and never enter the canary runner.

```ts
import {
  createFileProviderServiceStateStore,
  createProviderCanaryHttpsServer,
  createProviderCanaryServiceHost,
  createStaticProviderServiceRoleAuthorizer,
} from "@elizaos/scenario-runner/provider-qualified/provider-service-host";

const host = createProviderCanaryServiceHost({
  authorizer: createStaticProviderServiceRoleAuthorizer(rolePolicies),
  stateStore: createFileProviderServiceStateStore("/var/lib/eliza-canary"),
  observer: {
    endpoint: "https://observer.example/provider-canary/v1/service",
    organizationId: "independent-observer.example",
    signer: observerHsmAdapter,
    adapter: providerObserverAdapter,
  },
  audit(event) {
    securityAuditSink.write(event); // hashes and request IDs only
  },
});

const server = createProviderCanaryHttpsServer({ host, tls: tlsOptions });
server.listen(8443, "127.0.0.1");
```

The static authorizer accepts only bearer-token SHA-256 digests. Its policy
selects one exact role, manifest, run, scenario, operation, and authorization
window (or one exact sorted secret-ref set). For every request it derives a
self-hashed grant bound to the exact bearer digest, canonical request digest,
and nonce. Deployments with an external policy engine implement
`ProviderServiceRoleAuthorizer` and must return the same closed grant shape.

Authorization windows may not exceed five minutes. The host rejects expired,
future, role-substituted, cross-run, cross-operation, cross-credential, and
cross-request grants before invoking an adapter. Every accepted nonce is
atomically claimed under the grant digest. A duplicate nonce is refused even
when the bytes are identical.

## Durable state and crash behavior

`createFileProviderServiceStateStore` is the built-in single-host durable
journal. Supply an existing absolute directory owned by the service user with
mode `0700`. The store:

- refuses symlinked roots and namespaces;
- creates state and replay files with exclusive `O_EXCL | O_NOFOLLOW` and mode
  `0600`;
- fsyncs each file and the containing directory before acknowledging success;
- never deletes replay claims automatically; and
- refuses to replace observer sessions, completed material, judge verdicts, or
  cleanup results.

For horizontally scaled deployments, implement `ProviderServiceStateStore`
with linearizable `claimReplay` and `putOnce` operations and durable reads. An
eventual-consistency store is unsafe. `createInMemoryProviderServiceStateStore`
is explicitly test-only.

If a provider effect or cleanup succeeds but the durable record or response
fails, stop the canary and reconcile manually. Do not retry an ambiguous
operation. Retaining a stale claim is safe; losing a claim can reopen an effect
or signing replay window.

## Non-blind signing requirements

The host performs structural and cryptographic checks, but the service adapters
must establish real-world truth:

- `observer.complete` must read its own authenticated provider and durable-state
  sources for the active observer session.
- `observer.validateEvidenceForSigning` must re-query observer-owned state and
  return the exact validation digest for the completed material and payload.
- `semanticJudge.evaluate` must run the independently administered model.
- `semanticJudge.validateEvidenceForSigning` must re-query the stored evaluation
  and validate the exact verdict payload.
- `observer.validateCleanupForSigning` must independently verify the unsigned
  cleanup receipt and provider state; merely echoing the cleanup service response
  is a blind-signing bug.

The host also requires observer evidence material to equal the exact material
recorded at `observer-complete`, and judge verdicts to equal the exact result
recorded at `semantic-judge-evaluate`. It verifies every returned Ed25519
signature locally against the configured public key before responding. The
signer interface accepts bytes and a digest/purpose only; it has no method that
exports private key material.

## Secret broker

The secret endpoint defaults to `/provider-canary/v1/secrets`; all other roles
use `/provider-canary/v1/service`. A secret grant fixes the exact sorted list of
references. The response must contain exactly those keys. Private-key PEM
material is refused because evidence signers belong behind HSM/KMS adapters,
not the runner's bearer resolver.

Bearer authentication protects transport calls but is not provider
authorization. Provider adapters must independently bind their provider
credential/account, target, request payload, OAuth scopes, failure probes,
trajectory environment, and cleanup scope to the authorized manifest.

## HTTP and error contract

Only credential-free HTTPS URLs, `POST`, `application/json`, exact configured
paths, bounded UTF-8 JSON bodies, and closed protocol envelopes are accepted.
Queries, fragments, redirects, unknown roles, unknown fields, oversized bodies,
and replayed nonces fail closed. Successful service responses echo the exact
role, nonce, and canonical request SHA-256.

Failures return only
`eliza.provider-canary-service-error.v1`, `request-refused`, and a random request
ID. Adapter exceptions, tokens, provider errors, secret refs, and signing details
are never reflected. Audit events contain only outcome, role, request digest,
and request ID; operators must keep their audit callback secret-safe too.

## Evidence status

Passing these protocol tests proves only that the host refuses malformed,
unauthorized, replayed, substituted, or blindly signed requests under the SDK
contract. It does not prove a provider call happened, an observer is
independent, a model judged a trajectory, cleanup succeeded, or any canary is
qualified. Publishability still requires the bridge, signed artifacts, offline
reverification, and all 13 real-provider catalog rows.
