# Devices & Runtimes manual acceptance

Run this only from the exact pushed draft-PR head. Record commit, artifact,
tenant, service, device, and host identities without recording secrets.

## Required topology

- Isolated non-production API tenant, PostgreSQL database, and Headscale v0.28
  service whose deployment metadata identifies the exact PR commit.
- Exact-source Mac app on this Mac and a separately identified second Mac.
- Signed physical iPhone. Simulator evidence is useful but cannot prove
  signing, Keychain, cellular, VoiceOver, or physical radio transitions.
- User-controlled VPS with Eliza bound only to `127.0.0.1:2138` and a host
  fingerprint confirmed out of band.

Do not use the physical Seeker/ADB, production/shared staging, another lane's
app, or native port 50001.

## Backend and rollback preflight

1. Confirm the deployment source equals the draft-PR head and capture health,
   migration-tail, PostgreSQL backup/rollback marker, and service identifiers.
2. Apply the complete locked migration chain; verify Devices migrations 0305,
   0306, and 0310 plus upstream migrations 0307, 0308, and 0309 are each
   present exactly once, and the controller, host, relay, start-fence,
   managed-network, and cleanup constraints exist. Migration 0309 is the
   upstream legacy-BlueBubbles retirement; 0310 is the Devices managed-network
   migration. Do not renumber or collapse either entry during staging setup.
3. Create and clean up one Headscale pre-auth key and node. Exercise database-
   success/Headscale-failure, client-disconnect, missing-key/node, repeated
   revoke, and service-restart compensation. Confirm no secret key is stored.
4. Roll back only the disposable tenant or restore it from its recorded marker;
   never use production data for this exercise.

The Headscale steps above accept the server-side compensation primitive only.
They do not turn managed networking into a user-visible product claim; a future
native client must separately prove secure credential consumption and teardown.

## Pairing and authority

1. From a signed-out phone, scan a fresh QR challenge and finish authentication
   within five minutes. Verify the same device/key identity is retained.
2. Revoke it, then pair independently with a six-digit code. Verify QR and code
   challenges are one-use and reject expiry, replay, wrong owner, wrong device,
   wrong key, wrong session, wrong target, and capability escalation.
3. Restart both apps. Revoked controllers and runtimes must not return.

## Runtime selection and commands

1. Register this Mac, the second Mac, Cloud, and the VPS. Switch among them and
   verify the active runtime is explicit before every command.
2. Run a harmless command on each target and match accepted/start/completion
   receipts to the same controller, target, and attempt.
3. Crash before durable start and verify one bounded retry. Crash after durable
   start and verify no automatic re-execution; show the ambiguous recovery UI.
4. Interrupt the relay, then restore it. Verify bounded retry, no duplicate
   execution, and accurate offline/reconnecting state.

## VPS and SSH recovery

1. Confirm the VPS `SHA256:` fingerprint independently, then add it through
   **Settings -> Devices & Runtimes -> Advanced**. Keep the private key on this
   Mac.
2. Verify the tunnel reaches only the loopback agent API and refuses settings
   or arbitrary paths.
3. Exercise VPS down/up, Mac app restart, full Mac restart, and cleanup retry.
4. Present a deliberately changed host key and verify a hard rejection with no
   trust override. Restore the correct key out of band.

## Phone and accessibility

1. Transition Wi-Fi -> cellular -> airplane/offline -> cellular -> Wi-Fi while
   a harmless command is pending. Verify clear state, bounded retry, and
   exactly-once execution.
2. Cover portrait and landscape, narrow and wide layouts, keyboard/focus,
   VoiceOver, largest Dynamic Type, increased contrast, reduced motion, and
   44-point minimum targets for pair, select, retry, revoke, and cleanup.
3. Remove the phone and VPS, restart every app, and verify no revoked authority,
   profile, tunnel, command, or runtime resurrects.

## Evidence matrix

Keep separate rows for local unit/integration tests, browser interaction,
Simulator, physical phone, second Mac, VPS, isolated PostgreSQL, real
Headscale, hosted CI/security, signing, review, and production. A passing row in
one class never fills another.
