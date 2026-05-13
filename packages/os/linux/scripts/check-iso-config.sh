#!/usr/bin/env bash
# Pre-build validation. Catches the bugs we hit between v1-v4 BEFORE
# a 30-minute ISO build:
#   - missing `boot=live components` in bootappend-live
#   - missing eliza user-creation in chroot hooks
#   - syntactically invalid systemd units
#   - chroot hooks that don't exist / aren't executable / fail shellcheck

set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo"

fail=0
note() { printf '\033[1;33mWARN\033[0m %s\n' "$*" >&2; }
err()  { printf '\033[1;31mFAIL\033[0m %s\n' "$*" >&2; fail=$((fail + 1)); }
ok()   { printf '\033[1;32m OK \033[0m %s\n' "$*"; }

# 1. boot=live components in bootappend-live (else initramfs busybox shell)
if grep -q 'CMDLINE_APPEND=.*boot=live components' live-build/auto/config; then
    ok 'bootappend-live includes boot=live components'
else
    err 'bootappend-live is missing "boot=live components" — initramfs will drop to busybox'
fi

# 2. eliza user created at build time (else User=eliza services fail)
if grep -q 'useradd.*eliza' live-build/config/hooks/normal/0500-*.hook.chroot; then
    ok 'hook 0500 creates eliza user at build time'
else
    err 'hook 0500 missing useradd — User=eliza services will fail'
fi

# 3. authorized_keys seeded for eliza
if [ -s live-build/config/includes.chroot_after_packages/etc/skel/.ssh/authorized_keys ]; then
    ok 'authorized_keys present in /etc/skel/.ssh/'
else
    note 'no authorized_keys in /etc/skel/.ssh — SSH login will fail'
fi

# 4. hooks are executable
for hook in live-build/config/hooks/normal/0[0-9]*-usbeliza-*.hook.chroot; do
    [ -e "$hook" ] || continue
    if [ -x "$hook" ]; then
        ok "$(basename "$hook") executable"
    else
        err "$(basename "$hook") not executable"
    fi
done

# 5. shellcheck the hooks (if available)
if command -v shellcheck >/dev/null 2>&1; then
    for hook in live-build/config/hooks/normal/0[0-9]*-usbeliza-*.hook.chroot; do
        [ -e "$hook" ] || continue
        if shellcheck "$hook" >/dev/null 2>&1; then
            ok "$(basename "$hook") shellcheck clean"
        else
            note "$(basename "$hook") has shellcheck warnings (run: shellcheck $hook)"
        fi
    done
else
    note 'shellcheck not installed — skipping hook syntax validation'
fi

# 6. systemd unit syntax (if systemd-analyze available)
if command -v systemd-analyze >/dev/null 2>&1; then
    for unit in live-build/config/includes.chroot_after_packages/etc/systemd/system/*.service; do
        [ -e "$unit" ] || continue
        if systemd-analyze verify "$unit" 2>&1 | grep -v -E "Failed to get description|Couldn't find user" | grep -qE 'error|invalid'; then
            note "$(basename "$unit") has systemd-analyze warnings"
        else
            ok "$(basename "$unit") systemd syntax ok"
        fi
    done
else
    note 'systemd-analyze not in PATH'
fi

# 7. staged opt/usbeliza has elizad binary + agent source
if [ -x live-build/config/includes.chroot_after_packages/opt/usbeliza/bin/elizad ]; then
    ok 'elizad binary staged'
else
    note 'elizad binary not staged (run just iso-stage)'
fi
if [ -d live-build/config/includes.chroot_after_packages/opt/usbeliza/agent/src/onboarding ]; then
    ok 'agent source staged with onboarding/'
else
    note 'agent source missing onboarding/ — run just iso-stage'
fi

if [ "$fail" -gt 0 ]; then
    echo
    err "$fail check(s) failed — fix before building."
    exit 1
fi
echo
ok 'all pre-build checks passed'
