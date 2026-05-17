# Phase 3 — Privacy-mode toggle (boot-menu pick)

Two boot-menu entries flip Tor routing on/off. "elizaOS" (default) =
direct internet, fast. "elizaOS — Privacy Mode" = everything through Tor,
like stock Tails. Same features either way, only speed differs.

Paths are relative to `TAILS = packages/os/linux/variants/milady-tails/tails`.

Status as of 2026-05-16: this overlay is implemented in source and is part
of the current rebuild/test pass. The implementation uses
`elizaos_privacy=1` in the bootloader entries, while the live-config hook
also accepts `elizaos.privacy=on` for compatibility.

## Key facts the spec relies on

- **Two bootloaders, two config paths.** GRUB-EFI uses a static template
  `config/binary_local-includes/EFI/debian/grub.cfg`. Syslinux/isolinux
  `live.cfg` is *generated* by live-build, then post-processed by
  `config/binary_local-hooks/10-syslinux_customize` — so the second
  syslinux entry needs a new binary hook, not a static edit.
- **Cmdline → flag-file** has an idiomatic home: Tails' `lib/live/config/`
  hooks (e.g. `0000-boot-profile` does `grep -qw "profile" /proc/cmdline`).
  A new `lib/live/config/` hook is the Tails-native mechanism.
- **Firewall** = `config/chroot_local-includes/etc/ferm/ferm.conf` (the
  Tor-only ruleset), applied unconditionally by dispatcher `00-firewall.sh`.
- **Tor** is not masked at build; `tor@default.service` is enabled via
  the Debian preset and restarted by `10-tor.sh` on interface-up.
- **resolv.conf**: `config/chroot_local-includes/etc/resolv.conf` ships
  static `nameserver 127.0.0.1` (Tor's DNSPort).

## Files to ADD

1. **`TAILS/config/chroot_local-includes/lib/live/config/0001-elizaos-privacy-mode`** — the cmdline→flag mechanism, following the sibling `0000-boot-profile` pattern. `mkdir -p /etc/elizaos`; `elizaos_privacy=1` or `elizaos.privacy=on` on `/proc/cmdline` → write `on` to `/etc/elizaos/privacy-mode`, explicit off values write `off`, and absence removes the marker. Named `0001-` so it runs before any NM dispatcher. Mode `0755`.
2. **`TAILS/config/chroot_local-includes/etc/ferm/ferm-direct.conf`** — the permissive "Normal mode" ruleset: keep Tails' INPUT defaults, but OUTPUT policy ACCEPT (or explicit allow for the `amnesia`/`clearnet`/`debian-tor` UIDs), and **drop the nat-table OUTPUT REDIRECT rules** (the transparent-proxy-to-Tor redirects — they'd blackhole traffic when Tor isn't running).
3. **`TAILS/config/binary_local-hooks/10-syslinux_customize`** — the existing syslinux customization hook now also duplicates the generated isolinux `live` entry as `elizaOS ... - Privacy Mode` with `elizaos_privacy=1` appended to the `append` line. Keeps the original entry first/default.

## Files to EDIT

4. **`TAILS/config/binary_local-includes/EFI/debian/grub.cfg`** — add one `menuentry 'elizaOS — Privacy Mode' --id 'live-privacy'` after the `live` entry, with `... CMDLINE_APPEND elizaos_privacy=1 ...`. The `CMDLINE_APPEND`/`TAILS_VERSION` tokens are auto-substituted by `50-grub-efi` (no hook change needed). The default `live` entry stays first → stays default. Do **not** add an explicit off flag to it — absence is "off".
5. **`TAILS/config/chroot_local-includes/etc/NetworkManager/dispatcher.d/00-firewall.sh`** — branch on the flag:
   ```
   PRIVACY="$(cat /etc/elizaos/privacy-mode 2>/dev/null || echo on)"
   [ "$PRIVACY" = on ] && ferm /etc/ferm/ferm.conf || ferm /etc/ferm/ferm-direct.conf
   ```
   **Fail-closed**: missing/unreadable flag → default `on` (Tor-only). In the `off` branch, also rewrite `/etc/resolv.conf` from `$IP4_NAMESERVERS` (reuse the `00-resolv-over-clearnet` loop); in `on`, restore static `nameserver 127.0.0.1`.
6. **`TAILS/config/chroot_local-includes/etc/NetworkManager/dispatcher.d/10-tor.sh`** — early-exit when the flag ≠ `on`. Tor stays enabled but inert in Normal mode (nothing restarts it).

## Decision points
- **resolv.conf approach**: recommend writing `/etc/resolv.conf` inline in `00-firewall.sh` from `$IP4_NAMESERVERS` (reuses an audited Tails codepath) over NM-managed (needs NM reconfiguration).
- **Truly mask Tor?** PLAN says "masked" but a runtime cmdline flag can't drive a build-time mask. Either accept "not started" (functionally equivalent for v1.0) or have hook #1 do `systemctl mask`/`unmask` based on the flag.

## Milady chat action — "show me my network status"
Lives in the Milady agent (not Tails code) — wired in Phase 6. The only Tails-side contract Phase 3 owns: **`/etc/elizaos/privacy-mode` is the single source of truth** that the firewall, Tor, resolv.conf, and the chat action all read. Do not invent a second status file.

## Also in scope (doc, not code)
Update `docs/privacy-mode-v1-gap.md` with implementation evidence: Phase 3 closes the *routing* gap (agent/system traffic), but the Chromium WebView leak remains (nothing here injects `--proxy-server` into Electrobun) — deferred to v1.1.

## Ordered implementation checklist
1. Add `lib/live/config/0001-elizaos-privacy-mode`.
2. Add `etc/ferm/ferm-direct.conf` (drop the nat-OUTPUT Tor redirects).
3. Edit `00-firewall.sh` — branch on flag, fail-closed; handle resolv.conf per-mode.
4. Edit `10-tor.sh` — early-exit when flag ≠ `on`.
5. Edit `grub.cfg` — add the `live-privacy` menuentry.
6. Extend `binary_local-hooks/10-syslinux_customize` to add the syslinux privacy entry.
7. Update `docs/privacy-mode-v1-gap.md`.
8. Test in QEMU: default entry → no Tor, direct traffic + NM DNS; Privacy entry → `tor@default.service` active, Tor-only firewall, resolv.conf `127.0.0.1`. Confirm `/etc/elizaos/privacy-mode` reads `off`/`on`. Confirm fail-closed: corrupt the flag → Tor-only still applied.
