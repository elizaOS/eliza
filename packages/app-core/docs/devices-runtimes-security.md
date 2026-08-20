# Devices & Runtimes security model

Devices & Runtimes is a first-party Settings surface, not an agent plugin. Eliza
Cloud supplies account authority and managed reachability; Headscale is an
implementation detail and users do not need a Tailscale account.

## Pairing

- A host creates a five-minute, one-use six-digit challenge for exactly one
  account-owned Cloud agent or enrolled host.
- Cloud stores only a tenant-, owner-, target-, session-, purpose-, and
  expiry-bound HMAC verifier. It never stores the code itself.
- The controller consumes the challenge while authenticated to the same Cloud
  account and contributes separate P-256 signing and ECDH public keys.
- iPhone private keys are device-only Keychain/Secure Enclave keys. Desktop
  private keys live in Keychain or Secret Service. Plain browser clients cannot
  become trusted controllers.
- Existing active sessions that predate device-bound keys are revoked during
  migration instead of being silently upgraded.

## Transport and commands

- Managed Macs and VPS hosts use a locked `tag:eliza-remote-host` Headscale ACL.
  Remote hosts cannot initiate connections to agents or one another.
- Commands are signed, encrypted end to end, bound to owner/session/controller/
  target/nonce/sequence/expiry/payload digest, and rejected on replay.
- Cloud relay code treats encrypted envelopes as opaque data. Authorization and
  replay checks remain mandatory at the target runtime.
- Advanced SSH uses the desktop SSH agent by default, passes arguments without a
  shell, remembers first-seen host keys, rejects changed keys, and exposes only
  a loopback tunnel to the renderer.

## Secret storage

Runtime bearer tokens, Headscale enrollment keys, controller private keys, and
SSH private keys or references never enter browser localStorage or UserDefaults.
Public device IDs, host IDs, labels, and public keys are not secrets and may be
stored as local app metadata.
