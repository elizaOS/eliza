# packaging(debian): install the signed desktop, tray, overlay, agent, and control broker

Repository: `elizaOS/os`

Suggested labels: `linux`, `debian`, `packaging`, `desktop`, `release-blocker`

## Problem

The existing Debian package is a Node service/dashboard package, not the same
signed GTK/WebKit desktop delivered by the OS image. It does not satisfy the
vanilla-Linux tray, overlay, Cloud onboarding, computer-use, or Full Control
contract.

## Work

Split architecture-correct packages that consume immutable signed artifacts
from `elizaOS/eliza`:

- `eliza-desktop`;
- `eliza-agent`;
- `eliza-computer-use`;
- `eliza-system-helper`;
- `elizaos-branding` where appropriate.

Install `.desktop`, AppStream, icons, deep links, user units, D-Bus/polkit,
sysusers/tmpfiles, portal dependencies, Secret Service integration, and a
doctor command. Full Control defaults on only in the elizaOS image; a vanilla
Debian/Ubuntu package requires owner enablement.

## Acceptance criteria

- Native amd64 and arm64 packages pass lintian as a blocking gate.
- Fresh Debian 13 and Ubuntu LTS installations show the app and complete
  system-browser Cloud sign-in and first reply.
- Tray, overlay, close-to-tray, deep links, autostart choice, upgrade,
  downgrade, remove, purge, and multi-user isolation pass.
- Maintainer scripts do not assume a live user D-Bus session.
- Package removal leaves owner data unless purge is explicitly requested.
- Signed artifact failure, wrong architecture, downgrade/rollback metadata,
  missing portal, locked keyring, and unavailable privileged helper return
  typed failures rather than partial installation success.
