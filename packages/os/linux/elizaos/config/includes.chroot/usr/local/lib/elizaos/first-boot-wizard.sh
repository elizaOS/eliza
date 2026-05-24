#!/bin/sh
# elizaOS first-boot interactive setup wizard.
#
# Runs ONCE at first boot on /dev/tty1 before getty hands the seat to
# autologin → cage → kiosk. Surfaces three minimal setup questions:
#
#   1. Language       (writes /etc/locale.gen + runs locale-gen + update-locale)
#   2. Timezone       (timedatectl set-timezone)
#   3. Persistence    (records intent in /etc/elizaos/persistence-intent;
#                      actual LUKS-on-USB persistence is not yet implemented
#                      in elizaos/ — that subsystem was Tails-derived and lost
#                      with the variants/milady-tails removal in 4c96fee98e;
#                      recording the intent here so a future installer hook can
#                      honor it without re-asking the user)
#
# Fail-closed: if whiptail / locale-gen / timedatectl are unavailable, log
# the gap and mark the wizard complete with defaults rather than blocking
# boot. This is a UX wizard, not a release gate.
#
# Non-interactive auto-skip: when ELIZAOS_NONINTERACTIVE=1 is set (CI, QEMU
# smoke tests, scripted builds) or stdin is not a TTY, the wizard records
# defaults (en_US.UTF-8 / UTC / persistence=disabled) without prompting and
# exits 0. This keeps elizaos-first-boot-wizard.service from hanging
# `multi-user.target` in any unattended boot path.

set -eu

STATE=/var/lib/elizaos
ETC=/etc/elizaos
MARK="${STATE}/.first-boot-wizard-complete"

emit() {
    echo "elizaos-first-boot-wizard: $*"
    echo "elizaos-first-boot-wizard: $*" >/dev/kmsg 2>/dev/null || true
}

if [ -e "${MARK}" ]; then
    emit "wizard already complete; skip"
    exit 0
fi

mkdir -p "${STATE}" "${ETC}"

write_defaults() {
    reason="${1:-defaults}"
    emit "applying defaults (${reason}): LANG=en_US.UTF-8 TZ=UTC persistence=disabled"
    printf 'LANG=en_US.UTF-8\nTZ=UTC\n' >"${ETC}/locale-tz.env"
    printf 'intent=disabled\nreason=%s\n' "${reason}" >"${ETC}/persistence-intent"
}

if [ "${ELIZAOS_NONINTERACTIVE:-0}" = "1" ] || [ ! -t 0 ]; then
    write_defaults "non-interactive-boot"
    touch "${MARK}"
    exit 0
fi

if ! command -v whiptail >/dev/null 2>&1; then
    write_defaults "whiptail-unavailable"
    touch "${MARK}"
    exit 0
fi

# Language menu. Keep the list small + obviously-extensible; full locale list
# would be hundreds of entries that swamp the TUI.
if LANG_CHOICE=$(whiptail \
        --title "elizaOS Setup — Language" \
        --notags --noitem \
        --menu "Choose your language:" 16 60 6 \
        en_US.UTF-8 "English (United States)" \
        en_GB.UTF-8 "English (United Kingdom)" \
        es_ES.UTF-8 "Spanish (Spain)" \
        fr_FR.UTF-8 "French (France)" \
        de_DE.UTF-8 "German (Germany)" \
        ja_JP.UTF-8 "Japanese (Japan)" \
        3>&1 1>&2 2>&3); then
    if [ -f /etc/locale.gen ] && command -v locale-gen >/dev/null 2>&1; then
        # Uncomment the chosen locale line (Debian's stock format is
        # "# en_US.UTF-8 UTF-8") then generate.
        sed -i "s|^# *${LANG_CHOICE}|${LANG_CHOICE}|" /etc/locale.gen || true
        locale-gen >/dev/null 2>&1 || emit "locale-gen failed; default UTF-8 remains"
        if command -v update-locale >/dev/null 2>&1; then
            update-locale LANG="${LANG_CHOICE}" >/dev/null 2>&1 || true
        fi
    fi
else
    LANG_CHOICE="en_US.UTF-8"
fi

# Timezone menu. Same minimalism — TZ_CHOICE is fed straight to timedatectl
# which validates against /usr/share/zoneinfo so a typo here would fail
# cleanly rather than silently mis-set the clock.
if TZ_CHOICE=$(whiptail \
        --title "elizaOS Setup — Timezone" \
        --notags --noitem \
        --menu "Choose your timezone:" 18 60 9 \
        America/New_York "US Eastern" \
        America/Chicago "US Central" \
        America/Denver "US Mountain" \
        America/Los_Angeles "US Pacific" \
        Europe/London "UK / Ireland" \
        Europe/Berlin "Central Europe" \
        Asia/Tokyo "Japan" \
        Asia/Shanghai "China / Singapore" \
        UTC "UTC (no offset)" \
        3>&1 1>&2 2>&3); then
    if command -v timedatectl >/dev/null 2>&1; then
        timedatectl set-timezone "${TZ_CHOICE}" 2>/dev/null \
            || emit "timedatectl rejected ${TZ_CHOICE}; UTC retained"
    fi
else
    TZ_CHOICE="UTC"
fi

# Persistence intent. We DO NOT implement LUKS-on-USB persistence here —
# that was the Tails-derived flow under variants/milady-tails/ that Shaw
# removed in 4c96fee98e and the consolidated elizaos/ tree has not yet
# replaced. Record the user's preference so a future install-time hook
# (or a separate, schedulable persistence-setup pass) can honor it
# without re-asking.
if whiptail \
        --title "elizaOS Setup — Encrypted persistence" \
        --yesno "Would you like encrypted persistence on this USB?\n\nNote: the on-USB LUKS persistence subsystem is not yet shipped in the consolidated elizaos build. Your answer is recorded for a future installer pass; the system will boot read-only-with-tmpfs-state for now either way." \
        14 70; then
    PERSIST_INTENT=enabled
else
    PERSIST_INTENT=disabled
fi

printf 'LANG=%s\nTZ=%s\n' "${LANG_CHOICE}" "${TZ_CHOICE}" >"${ETC}/locale-tz.env"
printf 'intent=%s\nreason=user-choice\nasked_at=%s\n' \
    "${PERSIST_INTENT}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    >"${ETC}/persistence-intent"

emit "wizard complete: LANG=${LANG_CHOICE} TZ=${TZ_CHOICE} persistence=${PERSIST_INTENT}"
touch "${MARK}"
