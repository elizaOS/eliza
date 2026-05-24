# Inherited Tails Sudoers Review

Date: 2026-05-17

Scope: broad sudoers rules inherited from the Tails base that are still present
in the elizaOS Live overlay. This review does not bless broad root for the
elizaOS app. It records which inherited Tails rules are accepted for Tails
feature parity and which mitigations must stay in place.

## Decision

elizaOS Live accepts the inherited Tails sudoers rules listed below for the
demo and release-candidate path because they back existing Tails features:
Greeter, Persistent Storage, Tor Browser, Tails Upgrader, and WhisperBack.

elizaOS-owned policy remains stricter:

- no elizaOS sudoers file may use `ALL`, `NOPASSWD: ALL`, arbitrary arguments,
  package managers, service managers, mount tools, disk writers, or shells
- the app runs as `amnesia`, not root
- root crossing for elizaOS features stays behind
  `/usr/local/lib/elizaos/capability-runner`
- the current elizaOS broker sudoers entry allows only `root-status`

Any new broad sudoers rule outside this reviewed list is a security failure.

## Reviewed Rules

| File | User | Command | Purpose | Risk | Decision |
|---|---|---|---|---|---|
| `tails-greeter-cryptsetup.toml` | `Debian-gdm` | `/sbin/cryptsetup` with arbitrary arguments | Lets the Tails Greeter unlock Persistent Storage before the live session starts. | Greeter compromise could invoke cryptsetup broadly. | Accept inherited rule; do not expose it to elizaOS app code. |
| `tails-greeter-umount.toml` | `Debian-gdm` | `/bin/umount` with arbitrary arguments | Lets the Tails Greeter cleanly unmount Persistent Storage devices during setup/error handling. | Greeter compromise could unmount arbitrary paths. | Accept inherited rule; keep it Greeter-only. |
| `tbb.toml` | `amnesia` | `/usr/local/lib/tails-run-tor-browser-in-flatpak` with `ENVFILE` | Preserves Tails Tor Browser launch path. | Wrapper argument validation is trusted; bad wrapper validation could widen browser launch control. | Accept inherited rule; elizaOS must not reuse it for app launch. |
| `tps.toml` | `amnesia`, `tails-persistent-storage` | Tails Persistent Storage frontend/service commands, including a privileged internal `NOPASSWD: ALL` bridge from `tails-persistent-storage` to `amnesia` | Keeps Tails Persistent Storage working. elizaOS data persistence is implemented as a native TPS feature. | This is the broadest inherited rule and requires upstream TPS trust. | Accept inherited rule for Tails parity; elizaOS adds only bounded TPS bindings and no whole-home or system persistence. |
| `upgrade.toml` | `amnesia`, `tails-upgrade-frontend`, `tails-install-iuk` | Tails signed Incremental Upgrade Kit flow, including internal `ALL` for the installer user | Preserves inherited IUK plumbing for future base-OS update compatibility. The automatic unit is gated by `/etc/elizaos/base-updates-enabled` until elizaOS owns the feed and signing process. | Updater compromise has high impact. | Accept inherited rule only as reviewed upstream plumbing; elizaOS app/runtime updates use separate signed manifests and must not bypass this review for OS/base updates. |
| `whisperback.toml` | `amnesia` | `/usr/local/bin/whisperback` with arbitrary arguments | Preserves inherited bug-reporting UX. | Wrapper argument validation is trusted; reports can contain sensitive data if user includes it. | Accept inherited rule; elizaOS should replace or constrain support reporting before enterprise release. |

## Mitigations

- `scripts/security-smoke.sh` fails on any broad elizaOS-owned sudoers rule.
- `scripts/security-smoke.sh` fails on any unexpected broad inherited sudoers
  rule not listed here.
- elizaOS persistence is implemented through bounded TPS bindings only.
- The app supervisor starts user services; it does not run the app as root.
- The update-manager never executes user-writable staged runtimes directly.
- Stable enterprise release still needs an external AppArmor, polkit, sudoers,
  systemd, and update-path audit.

## Production Follow-Up

Before a public enterprise release, decide whether to:

- keep these inherited rules unchanged and explicitly document Tails as the
  trusted base,
- carry a smaller downstream Tails policy patch,
- or upstream tighter argument validation to Tails.

Do not remove these rules casually. They are part of core Tails behavior, and
breaking them can break Persistent Storage, Greeter, Tor Browser, upgrades, or
support reporting.
