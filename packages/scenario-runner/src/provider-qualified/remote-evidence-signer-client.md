# Independent evidence signer client contract

The remote signer clients are transport and verification boundaries for an
operator-deployed provider observer and an independently operated semantic
judge. They do not provide either service and do not turn local or simulated
evidence into provider-qualified evidence.

Each deployment pin binds an exact normalized HTTPS endpoint URL, organization identifier, role, and
Ed25519 SPKI key fingerprint into `serviceIdentitySha256`. The preflight rejects
shared origins, organizations, or keys. A bearer token is sent only in the
`Authorization` header; it is absent from request payloads and fixed-shape
errors.

Every request contains the exact canonical evidence bytes and SHA-256 digest,
manifest/run/scenario/trajectory correlation, a random one-time nonce, and a
hard expiry. Redirects are disabled, time and body sizes are bounded, and the
response has a closed schema. The client requires an exact payload echo and
verifies the returned Ed25519 envelope against the pinned key locally before
returning it to orchestration.

Production operators still need to deploy two genuinely independent services,
provision their public pins and bearer credentials out of band, and retain
server-side nonce consumption/audit records. This module neither contains nor
accepts private signing keys.
