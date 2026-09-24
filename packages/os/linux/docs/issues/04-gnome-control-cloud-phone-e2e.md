# linux(e2e): qualify GNOME, Cloud inference, Full Control, and phone remote

Repository: `elizaOS/os`

Suggested labels: `linux`, `e2e`, `computer-use`, `cloud`, `mobile`, `release-blocker`

Depends on: signed Linux shell artifact and production phone pairing in
`elizaOS/eliza`.

## Work

On GNOME Wayland, prove the complete user path:

1. owner setup and network;
2. system-browser Eliza Cloud sign-in;
3. personal agent provisioning and first bounded reply;
4. tray, overlay, close/restore, notification, and global pause shortcut;
5. Wayland RemoteDesktop/ScreenCast, PipeWire, AT-SPI, clipboard, multi-monitor,
   fractional scaling, lock/unlock, and portal revocation;
6. typed system operation and explicit arbitrary-root argv execution;
7. phone pairing, remote request, local activity indicator, completion result,
   revocation, replay rejection, offline delivery, and concurrent local action;
8. emergency disable during an in-flight process and recovery boot.

## Acceptance criteria

- Cloud provides inference while all computer/root execution remains local.
- No root network listener or Cloud credential exists.
- Phone commands cannot bypass active-owner binding, emergency pause, local
  catastrophic confirmation, screen lock policy, or revocation.
- Tray and overlay start on every login for all three architectures.
- Arbitrary argv is not accidentally shell-interpreted; explicit shell argv is
  supported and audited as the requested unrestricted root capability.
- Audit receipts redact credentials and verify as an unbroken authenticated
  chain after reboot.
- Recovery can revoke phone/Cloud access without starting Eliza.
- Three consecutive scheduled runs and one physical-device run are green.
