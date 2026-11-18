# Product quality requirements

This document records the application state-correctness requirement. Product
feature scope and the MVP plan remain subject to maintainer approval under
[CONTRIBUTING.md](CONTRIBUTING.md).

## State correctness

Every feature must be strongly modeled in Quint. The model must describe the
application state that the feature owns, the transitions it permits, and its
interactions with other state owners. Features that do not own state must
identify the existing models whose contracts they use.

Models must cover the following behavior where applicable.

- Authorization, tenant and session ownership, expiry and revocation.
- Concurrent events, resource ownership and ordering across asynchronous work.
- Cancellation, retries, duplicate delivery and unknown external outcomes.
- Persistence, restart, recovery and compatibility with existing records.
- Complete model context, source selection, evidence and effect receipts.

Each model must have executable safety invariants and progress obligations
under explicit environmental and fairness assumptions. Record finite domains
and other abstraction limits. A passing model check establishes properties of
that model within those limits. Implementation conformance checks must exercise
the corresponding real transitions and guard against model drift.

Changes must update source mappings, model cases and conformance evidence in
the same PR. Run `bun run test:quint` and the owning package's checks. Report
unmodeled behavior and failed checks explicitly. The application-wide migration
is complete only when every maintained state owner has been reviewed and its
required model and implementation checks pass.

See the [Quint workflow](packages/scripts/quint/README.md) for model layout,
commands and verification evidence.

## MVP scope: Private passwords on Android

A person using a supported Android host can manage saved passwords on the
device. The owner can ask a trusted browser to fill or save a login for the
current HTTPS origin. The native browser must confirm that the active page
and login fields belong to that origin. Passwords reach the protected native
controls and the approved site's login fields. Page recordings, unrelated
origins, application bridges and the assistant do not receive passwords.
Recovery keys stay in protected native controls.

An owner can choose to keep one encrypted backup in the product's Cloud
account. The native client encrypts the complete snapshot before upload. The
Cloud stores the ciphertext and its revision for that account and product.
Each read, write or deletion requires recent interactive account
authentication and a separate, short-lived approval for that operation. An
inference key has no backup authority. A stale revision cannot replace the
current snapshot. The owner can remove the Cloud copy and keep the local
vault. On a replacement tablet, the owner confirms the same account, unlocks
the tablet and enters the recovery key to restore to an empty vault.

### MVP plan

1. Verify native save and fill on a trusted login page, and refusal on a
   different origin or a page whose identity cannot be confirmed.
2. Verify separate backup approval, revision conflicts, account isolation
   and revocation with synthetic identities. Verify that the native client
   can restore onto a second Android profile with the recovery key, refuses
   a wrong key or a nonempty destination, and can delete the Cloud copy.
3. Exercise the approved release in staging with a registered native client,
   a supported device lock and synthetic passwords. A host can offer the
   backup control when its account and backup service are available.
