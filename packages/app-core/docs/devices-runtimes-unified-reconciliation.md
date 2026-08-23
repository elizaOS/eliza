# Devices & Runtimes unified reconciliation

## Purpose

This branch reconciles two independently developed remote-control stacks into
one product. The preserved local rollback candidate
`c15175dfbf45eb22655cb5a2c4daf6ee4b085201` and its annotated tag remain
immutable. The merged implementation from PR #24414 is the publication base;
closed PR #23067 is historical review context only and must not be reopened or
presented as this branch.

This is a semantic consolidation, not a patch-identical cherry-pick. A raw
range-diff is expected to show reorganization because the two implementations
used different UI containers, SQL series, remote-target models, and SSH/relay
lifecycle code. The invariant manifest in
`devices-runtimes-unification-manifest.tsv` is the review map.

The publication checkpoint comparison was run as:

```sh
git range-diff \
  2342e22a882d5ef8a77ff239cb2d61049d88f631..c15175dfbf45eb22655cb5a2c4daf6ee4b085201 \
  origin/develop..181ebacd476fe1aa091da86b708b32eb6e7eff9a
```

It maps all seven old publication patches as removed and all eight unified
patches as added, with no `=` patch-identity rows. That is the expected and
review-relevant result: the old private branch is rollback evidence, while the
new series is a semantic merge on top of the already-merged #24414 model. The
manifest and focused failure-sensitive proof below establish retained
invariants; the range-diff must not be misrepresented as blob identity.

## Canonical architecture

- `DevicesRuntimesContainer` is the only stateful Devices & Runtimes UI.
  `MyRuntimesContainer` is a compatibility adapter and `MyRuntimesSection` is
  catalog-only legacy presentation. Settings exposes the canonical surface to
  users; it is no longer developer-only.
- Cloud migrations remain one contiguous suffix:
  `0305_secure_remote_hosts.sql`, `0306_secure_remote_command_relay.sql`, and
  `0309_remote_host_managed_network.sql`. Upstream owns
  `0307_twilio_outbound_call_audit.sql` and
  `0308_remove_conversation_token_default.sql`; the unpublished c151 migration
  block was not stacked or replayed under duplicate names.
- The merged secure pairing/session/relay model remains authoritative for
  device, owner, session, key, target, capability, expiry, replay, and durable
  start fencing.
- Electrobun is the only SSH gateway and remote-target executor. Target
  identities bind the real desktop platform (macOS, Windows, or Linux), strict
  SSH host-key verification is mandatory, and renderer-supplied authorization
  or forwarded-host headers are stripped.
- SSH setup/removal is serialized and restart-safe. Only public completion
  receipts are persisted; private key paths, credentials, fingerprints, and
  target addresses are never written to the receipt store.
- Optional managed Headscale enrollment is a server-side infrastructure
  primitive, not a user-visible Devices enrollment claim in this release. Only
  the public numeric pre-auth key identifier and cleanup state are stored;
  enrollment failures revoke authority and compensation is durable and
  retryable. The committed ACL grants its dedicated tag only an outbound HTTPS
  edge to the relay proxy, with no agent, peer-host, or inbound edge.

## Compatibility disposition

The compatibility adapter preserves imports of `MyRuntimesContainer` while
rendering the canonical UI. Existing v1 remote-target identity records that
lack a platform are read as Linux, but a stored identity cannot silently move
between platforms. The trusted private/Tailscale URL add path remains available
inside the canonical Advanced surface, while store/mobile builds hide and
refuse local execution. Old SSH lifecycle receipts are not trusted as
credentials; the secure store remains the sole credential authority.

## Review proof

The exact publication head must pass:

1. UI remote/settings/lifecycle tests and UI typecheck.
2. Electrobun target/SSH boundary tests, disposable real-system `sshd`
   integration, and Electrobun typecheck.
3. Cloud remote API tests, shared repository/Headscale/PGlite tests, and both
   Cloud typechecks.
4. Disposable real PostgreSQL composition of migrations 0305-0309, including
   upstream 0307 and 0308 before the Devices managed-network suffix.
5. Production story build plus responsive interaction at 380x844 and
   1440x1000 with no horizontal overflow and 44-point actions.
6. An exact-head unsigned iOS Simulator build whose cloud-only attestation
   embeds the publication commit and reports zero findings.

Local proof does not substitute for hosted review, a deployed isolated tenant,
a real Headscale lifecycle, signing, a physical phone, a second Mac, or a real
VPS. Those gates are defined in `devices-runtimes-manual-acceptance.md`.
The canonical authorization, encryption, execution, SSH, and managed-network
rules remain in `remote-control-security.md`.
