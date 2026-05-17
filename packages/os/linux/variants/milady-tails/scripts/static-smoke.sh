#!/usr/bin/env bash
# CPU-light static checks for the elizaOS Live overlay.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "${ROOT}/../../../../.." && pwd)"
SOURCE_ONLY="${ELIZAOS_STATIC_SOURCE_ONLY:-0}"
cd "${ROOT}"

echo "==> shell syntax"
bash -n build.sh build-iso.sh tails/auto/build scripts/generate-elizaos-brand-assets.sh
sh -n \
    tails/auto/config \
    tails/config/chroot_local-hooks/9100-install-milady \
    tails/config/chroot_local-hooks/9150-brand-inherited-strings \
    tails/config/chroot_local-hooks/99-zzzzzz_permissions \
    tails/config/chroot_local-includes/usr/sbin/swapon.tails \
    tails/config/chroot_local-includes/usr/local/bin/milady \
    tails/config/chroot_local-includes/usr/lib/live/config/0001-elizaos-privacy-mode \
    tails/config/chroot_local-includes/etc/NetworkManager/dispatcher.d/00-firewall.sh \
    tails/config/chroot_local-includes/etc/NetworkManager/dispatcher.d/00-resolv-over-clearnet \
    tails/config/chroot_local-includes/etc/NetworkManager/dispatcher.d/10-tor.sh \
    tails/config/chroot_local-includes/usr/local/lib/elizaos/capability-runner \
    tails/config/chroot_local-includes/usr/local/lib/elizaos/milady-keeper \
    tails/config/chroot_local-includes/usr/local/lib/elizaos/persistence-maintenance \
    tails/config/chroot_local-includes/usr/local/lib/elizaos/start-elizaos-agent-user \
    tails/config/chroot_local-includes/usr/local/lib/elizaos/start-elizaos-browser-user \
    tails/config/chroot_local-includes/usr/local/lib/elizaos/start-elizaos-renderer-user \
    tails/config/chroot_local-includes/usr/local/lib/elizaos/start-milady-user \
    tails/config/chroot_local-includes/usr/local/lib/persistent-storage/on-activated-hooks/MiladyData/10-clean-runtime-state \
    tails/config/chroot_local-includes/usr/local/lib/persistent-storage/on-activated-hooks/MiladyData/20-restart-milady \
    tails/config/chroot_local-includes/usr/local/lib/persistent-storage/on-deactivated-hooks/MiladyData/20-restart-milady

node --check scripts/prepare-milady-app-overlay.mjs
node --check tails/config/chroot_local-includes/usr/local/lib/elizaos/renderer-server.mjs
python3 - \
    tails/config/chroot_local-includes/usr/local/bin/tails-documentation \
    tails/config/chroot_local-includes/usr/local/lib/elizaos/elizaos-webkit-shell \
    tails/config/chroot_local-includes/usr/local/bin/electrum \
    tails/config/chroot_local-includes/usr/local/bin/tails-about \
    tails/config/chroot_local-includes/usr/local/bin/tails-upgrade-frontend-wrapper <<'PY'
import py_compile
import sys
import tempfile
from pathlib import Path

with tempfile.TemporaryDirectory(prefix="elizaos-pycompile-") as tmp:
    for index, path in enumerate(sys.argv[1:]):
        py_compile.compile(
            path,
            cfile=str(Path(tmp) / f"{index}.pyc"),
            doraise=True,
        )
PY

for unit in \
    tails/config/chroot_local-includes/etc/systemd/user/elizaos-agent.service \
    tails/config/chroot_local-includes/etc/systemd/user/elizaos-renderer.service \
    tails/config/chroot_local-includes/etc/systemd/user/milady.service
do
    grep -q '^ConditionUser=1000$' "${unit}"
done

for executable in \
    tails/config/chroot_local-includes/usr/local/lib/elizaos/elizaos-webkit-shell \
    tails/config/chroot_local-includes/usr/local/lib/elizaos/start-elizaos-browser-user \
    tails/config/chroot_local-includes/usr/local/lib/elizaos/start-elizaos-agent-user \
    tails/config/chroot_local-includes/usr/local/lib/elizaos/start-elizaos-renderer-user \
    tails/config/chroot_local-includes/usr/local/lib/elizaos/start-milady-user
do
    mode="$(stat -c %a "${executable}")"
    if [ "${mode}" != "755" ]; then
        echo "${executable} must be mode 755, got ${mode}" >&2
        exit 1
    fi
done

echo "==> elizaOS branding"
for font in Poppins-Regular.ttf Poppins-Medium.ttf OFL.txt; do
    test -f "tails/config/chroot_local-includes/usr/share/fonts/truetype/elizaos/${font}"
    font_mode="$(stat -c %a "tails/config/chroot_local-includes/usr/share/fonts/truetype/elizaos/${font}")"
    if [ "${font_mode}" != "644" ]; then
        echo "${font} must be mode 644, got ${font_mode}" >&2
        exit 1
    fi
done
grep -q "Poppins 10" \
    tails/config/chroot_local-includes/etc/dconf/db/local.d/00_Tails_defaults
grep -q "Poppins Medium 10" \
    tails/config/chroot_local-includes/etc/dconf/db/local.d/00_Tails_defaults
grep -q '^gir1.2-udisks-2.0$' \
    tails/config/chroot_local-packageslists/tails-common.list
grep -q '#0B35F1' scripts/generate-elizaos-brand-assets.sh
grep -q 'logo_white_bluebg.svg' scripts/generate-elizaos-brand-assets.sh
if rg -n '#FF5800|#FF0000|#ff5800|#ff0000|ORANGE|RED|#ffe600|#f0b90b|#08080a|#0a0a0a|#03061f' \
    scripts/generate-elizaos-brand-assets.sh \
    tails/config/chroot_local-includes/usr/share/tails/greeter/greeter.css \
    tails/config/chroot_local-includes/usr/share/doc/elizaos/website/doc.en.html \
    tails/config/chroot_local-includes/usr/local/lib/elizaos/elizaos-webkit-shell
then
    echo "Core visible elizaOS surfaces must use the blue/white/soft-grey brand palette." >&2
    exit 1
fi
grep -q 'font-family: "Poppins"' \
    tails/config/chroot_local-includes/usr/share/tails/greeter/greeter.css
if [ "${SOURCE_ONLY}" != "1" ]; then
    grep -q 'id="elizaos-live-theme"' \
        tails/config/chroot_local-includes/usr/share/elizaos/milady-app/Resources/app/renderer/index.html
    grep -q '#F7F9FF' \
        tails/config/chroot_local-includes/usr/share/elizaos/milady-app/Resources/app/renderer/index.html
    grep -q '"theme_color": "#F7F9FF"' \
        tails/config/chroot_local-includes/usr/share/elizaos/milady-app/Resources/app/renderer/site.webmanifest
    if rg -n '#08080a|#0a0a0a|black-translucent' \
        tails/config/chroot_local-includes/usr/share/elizaos/milady-app/Resources/app/renderer/index.html \
        tails/config/chroot_local-includes/usr/share/elizaos/milady-app/Resources/app/renderer/site.webmanifest
    then
        echo "Packaged app renderer must not expose the old dark shell metadata." >&2
        exit 1
    fi
fi
python3 - <<'PY'
try:
    import gi
    gi.require_version("Gtk", "4.0")
    from gi.repository import Gtk
except (ImportError, ValueError):
    print("skip: python gi/gtk unavailable for greeter CSS parser check")
else:
    Gtk.CssProvider().load_from_path(
        "tails/config/chroot_local-includes/usr/share/tails/greeter/greeter.css"
    )
PY
grep -q -- '--iso-application="elizaOS"' tails/auto/config
grep -q -- '--iso-publisher="https://elizaos.ai/"' tails/auto/config
grep -q -- '--iso-volume="ELIZAOS ' tails/auto/config
grep -q 'PRETTY_NAME="elizaOS"' tails/auto/config
grep -q 'SUPPORT_URL="https://elizaos.ai/"' tails/auto/config
grep -q 'BUG_REPORT_URL="https://elizaos.ai/"' tails/auto/config
grep -qx 'elizaOS' tails/config/chroot_local-includes/etc/issue.net
grep -q '^elizaOS \\n \\l$' tails/config/chroot_local-includes/etc/issue
grep -q 'WEBSITE_URL = "https://elizaos.ai"' \
    tails/config/chroot_local-includes/usr/lib/python3/dist-packages/tailslib/website.py
grep -q 'WEBSITE_LOCAL_PATH = "/usr/share/doc/elizaos/website"' \
    tails/config/chroot_local-includes/usr/lib/python3/dist-packages/tailslib/website.py
grep -q 'file:///usr/share/doc/elizaos/website/doc.en.html' \
    tails/config/chroot_local-includes/usr/local/bin/tails-documentation
grep -q 'font-family: "Poppins"' \
    tails/config/chroot_local-includes/usr/share/doc/elizaos/website/doc.en.html
grep -q '#0B35F1' \
    tails/config/chroot_local-includes/usr/share/doc/elizaos/website/doc.en.html
grep -q '"distribution": "elizaOS"' \
    tails/config/chroot_local-includes/usr/lib/python3/dist-packages/tails_installer/config.py
grep -q '"partition_label": "elizaOS"' \
    tails/config/chroot_local-includes/usr/lib/python3/dist-packages/tails_installer/config.py
if command -v identify >/dev/null 2>&1; then
    image_paths=(
        tails/config/chroot_local-includes/usr/share/tails/desktop_wallpaper.png \
        tails/config/chroot_local-includes/usr/share/tails/screensaver_background.png \
        tails/config/binary_local-includes/EFI/debian/grub/splash.png \
        tails/config/chroot_local-includes/usr/share/tails/greeter/icons/elizaos-logo.png \
        tails/config/chroot_local-includes/usr/share/tails/elizaos-about-logo.png \
        tails/config/chroot_local-includes/usr/share/plymouth/themes/elizaos/elizaos-wordmark.png \
        tails/config/chroot_local-includes/usr/share/tails-installer/tails-liveusb-header.png \
        tails/config/chroot_local-includes/usr/share/pixmaps/elizaos.png \
    )
    if [ "${SOURCE_ONLY}" != "1" ]; then
        image_paths+=(
            tails/config/chroot_local-includes/usr/share/elizaos/milady-app/Resources/app/assets/appIcon.png
            tails/config/chroot_local-includes/usr/share/elizaos/milady-app/Resources/app/renderer/favicon-256x256.png
        )
    fi
    identify "${image_paths[@]}" >/dev/null
fi
if rg -n \
    'Tails-based|Tails Cloner|Tails Documentation|Connect Tails|Tails USB stick|Milady Data|Save Milady|Activate Milady|Welcome to Milady|elizaOS \(Tails-based\)' \
    README.md ROADMAP.md docs/user-experience.md docs/mode-parity.md \
    PLAN.md docs/build-infrastructure.md \
    tails/auto/build tails/auto/config \
    tails/config/chroot_local-includes/etc \
    tails/config/chroot_local-includes/usr/share/tails \
    tails/config/chroot_local-includes/usr/share/applications \
    tails/config/chroot_local-includes/usr/share/doc/elizaos \
    tails/config/chroot_local-includes/usr/share/tails-installer \
    tails/config/chroot_local-includes/usr/lib/python3/dist-packages/tailsgreeter \
    tails/config/chroot_local-includes/usr/lib/python3/dist-packages/tps_frontend \
    tails/config/chroot_local-includes/usr/lib/python3/dist-packages/tails_installer \
    tails/config/chroot_local-includes/usr/lib/python3/dist-packages/tca \
    tails/config/chroot_local-includes/usr/local \
    tails/config/binary_local-includes
then
    echo "Visible elizaOS branding still contains stale Tails/Milady strings." >&2
    exit 1
fi
launcher_paths=(
    tails/config/chroot_local-includes/usr/share/applications/tails-documentation.desktop
    tails/config/chroot_local-includes/usr/share/applications/tails-backup.desktop
    tails/config/chroot_local-includes/usr/share/applications/tails-installer.desktop
    tails/config/chroot_local-includes/usr/share/applications/tca.desktop
    tails/config/chroot_local-includes/usr/share/applications/org.boum.tails.AdditionalSoftware.desktop
    tails/config/chroot_local-includes/usr/share/applications/whisperback.desktop
)
existing_launcher_paths=()
for launcher_path in "${launcher_paths[@]}"; do
    if [ -e "${launcher_path}" ]; then
        existing_launcher_paths+=("${launcher_path}")
    fi
done
if [ "${#existing_launcher_paths[@]}" -gt 0 ]; then
    if rg -n '^(Name|Comment|Keywords)\[' "${existing_launcher_paths[@]}"; then
        echo "Brand-sensitive desktop launchers must fall back to curated elizaOS labels." >&2
        exit 1
    fi
fi

if command -v desktop-file-validate >/dev/null 2>&1; then
    echo "==> desktop entries"
    desktop-file-validate \
        tails/config/chroot_local-includes/usr/share/applications/milady.desktop
else
    echo "skip: desktop-file-validate not installed"
fi

if [ -e tails/config/chroot_local-includes/etc/xdg/autostart/milady.desktop ]; then
    echo "Milady must be supervised by systemd, not XDG autostart." >&2
    exit 1
fi
grep -q '^Name=elizaOS$' \
    tails/config/chroot_local-includes/usr/share/applications/milady.desktop
grep -q '^Icon=elizaos$' \
    tails/config/chroot_local-includes/usr/share/applications/milady.desktop
grep -q '^Exec=/usr/local/bin/milady$' \
    tails/config/chroot_local-includes/usr/share/applications/milady.desktop

echo "==> Milady launch policy"
if grep -q 'ELECTROBUN_CONSOLE.*:-1' \
    tails/config/chroot_local-includes/usr/local/bin/milady; then
    echo "Milady must not force Electrobun console mode in elizaOS Live." >&2
    exit 1
fi
grep -q 'ELIZA_DESKTOP_FORCE_CEF.*:-0' \
    tails/config/chroot_local-includes/usr/local/bin/milady
grep -q 'ELIZA_STARTUP_STATE_FILE' \
    tails/config/chroot_local-includes/usr/local/bin/milady
grep -q 'ELIZA_STARTUP_EVENTS_FILE' \
    tails/config/chroot_local-includes/usr/local/bin/milady
grep -q 'ELIZA_APP_ID.*ai.elizaos.app' \
    tails/config/chroot_local-includes/usr/local/bin/milady
grep -q 'ELIZAOS_LIVE_EMBEDDING_FALLBACK.*:-1' \
    tails/config/chroot_local-includes/usr/local/bin/milady
grep -q 'ELIZA_DISABLE_PROACTIVE_AGENT.*:-1' \
    tails/config/chroot_local-includes/usr/local/bin/milady
grep -q 'ELIZAOS_CLOSE_MINIMIZES_TO_TRAY.*:-1' \
    tails/config/chroot_local-includes/usr/local/bin/milady
grep -q 'ELIZAOS_CEF_PROFILE_COMPAT.*:-1' \
    tails/config/chroot_local-includes/usr/local/bin/milady
grep -q 'normalize_tcp_port' \
    tails/config/chroot_local-includes/usr/local/bin/milady
grep -q 'normalize_loopback_bind' \
    tails/config/chroot_local-includes/usr/local/bin/milady
grep -q 'ELIZA_API_PORT.*:-31337' \
    tails/config/chroot_local-includes/usr/local/bin/milady
grep -q 'ELIZA_DESKTOP_API_BASE.*127.0.0.1' \
    tails/config/chroot_local-includes/usr/local/bin/milady
grep -q 'ELIZA_API_BASE.*ELIZA_DESKTOP_API_BASE' \
    tails/config/chroot_local-includes/usr/local/bin/milady
grep -q 'ELIZA_API_STRICT_PORT.*:-1' \
    tails/config/chroot_local-includes/usr/local/bin/milady
grep -q 'ELIZA_API_STRICT_PORT.*:-1' \
    tails/config/chroot_local-includes/usr/local/lib/elizaos/start-elizaos-agent-user
grep -q 'strictPortBindingEnabled' \
    "${REPO_ROOT}/packages/agent/src/api/server.ts"
grep -q 'Strict port binding is enabled' \
    "${REPO_ROOT}/packages/agent/src/api/server.ts"
grep -q '"Feather"' scripts/prepare-milady-app-overlay.mjs
grep -q '"Maximize2"' scripts/prepare-milady-app-overlay.mjs
grep -q 'Resources/app' scripts/prepare-milady-app-overlay.mjs
grep -q 'matchAll(namedImportRe)' scripts/prepare-milady-app-overlay.mjs
grep -q 'matchAll(destructuredImportRe)' scripts/prepare-milady-app-overlay.mjs
grep -q 'shouldWriteLiveFallbackPackage' scripts/prepare-milady-app-overlay.mjs
grep -q 'elizaos-live-overlay-manifest.json' scripts/prepare-milady-app-overlay.mjs
grep -q 'closeMinimizesToTray: true' scripts/prepare-milady-app-overlay.mjs
grep -Fq 'runtime["closeMinimizesToTray"] = True' \
    tails/config/chroot_local-hooks/9100-install-milady
grep -q 'prepare_cef_profile' \
    tails/config/chroot_local-includes/usr/local/bin/milady
grep -q 'safe_cache_component' \
    tails/config/chroot_local-includes/usr/local/bin/milady
grep -q 'archive_cef_path' \
    tails/config/chroot_local-includes/usr/local/bin/milady
grep -q 'ln -sfn . "${cef_root}/partitions"' \
    tails/config/chroot_local-includes/usr/local/bin/milady
grep -q 'mkdir -p "${cef_root}/default"' \
    tails/config/chroot_local-includes/usr/local/bin/milady
grep -Fq 'printf '"'"'2\n'"'"' > "${cef_root}/.electrobun_cef_cache_version"' \
    tails/config/chroot_local-includes/usr/local/bin/milady
if grep -q 'mkdir -p.*partitions/default' \
    tails/config/chroot_local-includes/usr/local/bin/milady; then
    echo "Milady launcher must not create nested CEF partitions/default directories." >&2
    exit 1
fi
if grep -q 'rm -rf.*partitions/default' \
    tails/config/chroot_local-includes/usr/local/bin/milady; then
    echo "Milady launcher must not wipe the persistent CEF profile on every start." >&2
    exit 1
fi
if grep -q 'rm -rf.*Partitions/default' \
    tails/config/chroot_local-includes/usr/local/bin/milady; then
    echo "Milady launcher must not wipe the persistent CEF profile on every start." >&2
    exit 1
fi
grep -q '.electrobun_cef_cache_version' \
    tails/config/chroot_local-includes/usr/local/bin/milady
if grep -q "printf '3\\\\n'" \
    tails/config/chroot_local-includes/usr/local/bin/milady; then
    echo "Milady launcher must write the CEF cache marker expected by the app." >&2
    exit 1
fi
grep -q 'ai.milady.milady/dev/CEF' \
    tails/config/chroot_local-includes/usr/local/bin/milady

echo "==> elizaOS privacy fail-closed"
grep -q 'elizaos_privacy=0' \
    tails/config/binary_local-includes/EFI/debian/grub.cfg
grep -q 'elizaos_privacy=1' \
    tails/config/binary_local-includes/EFI/debian/grub.cfg
grep -q 'elizaos_privacy=0' \
    tails/config/binary_local-hooks/10-syslinux_customize
grep -q 'elizaos_privacy=1' \
    tails/config/binary_local-hooks/10-syslinux_customize
grep -q 'printf.*on.*> /etc/elizaos/privacy-mode' \
    tails/config/chroot_local-includes/usr/lib/live/config/0001-elizaos-privacy-mode
grep -q 'printf on' \
    tails/config/chroot_local-includes/etc/NetworkManager/dispatcher.d/00-firewall.sh
grep -q 'printf on' \
    tails/config/chroot_local-includes/etc/NetworkManager/dispatcher.d/10-tor.sh
grep -q 'printf on' \
    tails/config/chroot_local-includes/etc/NetworkManager/dispatcher.d/00-resolv-over-clearnet
grep -q 'printf on' \
    tails/config/chroot_local-includes/usr/local/bin/milady
grep -q 'printf on' \
    tails/config/chroot_local-includes/usr/local/lib/elizaos/capability-runner

echo "==> Milady persistence contract"
python3 - <<'PY'
from pathlib import Path
path = Path("tails/config/chroot_local-includes/usr/lib/python3/dist-packages/tps/configuration/features.py")
text = path.read_text()
required = [
    'Binding("milady/eliza", "/home/amnesia/.eliza")',
    'Binding("milady/milady", "/home/amnesia/.milady")',
    'Binding("milady/config", "/home/amnesia/.config/elizaOS")',
    'Binding("milady/config-legacy", "/home/amnesia/.config/milady")',
    'Binding("milady/config-legacy-caps", "/home/amnesia/.config/Milady")',
    'Binding("milady/cef-cache", "/home/amnesia/.cache/ai.elizaos.app")',
    'Binding("milady/cef-cache-legacy", "/home/amnesia/.cache/ai.milady.milady")',
    'translatable_name = "elizaOS Data"',
    'name="elizaOS"',
    'desktop_id="milady.desktop"',
    'process_names=["launcher", "bun"]',
    'self._run_persistence_maintenance("enter")',
    'self._run_persistence_maintenance("leave")',
]
missing = [item for item in required if item not in text]
if missing:
    raise SystemExit(f"{path}: missing MiladyData entries: {missing}")
PY
for launcher in \
    tails/config/chroot_local-includes/usr/local/bin/milady \
    tails/config/chroot_local-includes/usr/local/lib/elizaos/start-elizaos-agent-user \
    tails/config/chroot_local-includes/usr/local/lib/elizaos/start-elizaos-browser-user \
    tails/config/chroot_local-includes/usr/local/lib/elizaos/start-elizaos-renderer-user \
    tails/config/chroot_local-includes/usr/local/lib/elizaos/start-milady-user
do
    grep -q 'persistence-maintenance wait' "${launcher}"
done
grep -q 'run_dir=/run/elizaos' \
    tails/config/chroot_local-includes/usr/local/lib/elizaos/persistence-maintenance
grep -Fq 'flag="${run_dir}/persistence-maintenance"' \
    tails/config/chroot_local-includes/usr/local/lib/elizaos/persistence-maintenance
grep -q 'systemctl --user "$@"' \
    tails/config/chroot_local-includes/usr/local/lib/elizaos/persistence-maintenance
grep -q 'kill --kill-whom=all --signal=TERM' \
    tails/config/chroot_local-includes/usr/local/lib/elizaos/persistence-maintenance
grep -q 'kill --kill-whom=all --signal=KILL' \
    tails/config/chroot_local-includes/usr/local/lib/elizaos/persistence-maintenance
if grep -q 'pkill .* -u amnesia' \
    tails/config/chroot_local-includes/usr/local/lib/elizaos/persistence-maintenance; then
    echo "persistence-maintenance must not use broad pkill patterns against the live user." >&2
    exit 1
fi
helper_mode="$(stat -c %a tails/config/chroot_local-includes/usr/local/lib/elizaos/persistence-maintenance)"
if [ "${helper_mode}" != "755" ]; then
    echo "persistence-maintenance must be mode 755, got ${helper_mode}" >&2
    exit 1
fi

echo "==> filesystem modes"
if [ -d tails/config/chroot_local-includes/sbin ]; then
    echo "top-level chroot_local-includes/sbin would replace Tails' /sbin -> /usr/sbin symlink" >&2
    exit 1
fi
if [ -d tails/config/chroot_local-includes/lib ]; then
    echo "top-level chroot_local-includes/lib would replace Tails' /lib -> /usr/lib symlink" >&2
    exit 1
fi
if [ -e tails/config/chroot_local-includes/tmp ]; then
    tmp_mode="$(stat -c %a tails/config/chroot_local-includes/tmp)"
    if [ "${tmp_mode}" != "1777" ]; then
        echo "tails/config/chroot_local-includes/tmp must be mode 1777, got ${tmp_mode}" >&2
        exit 1
    fi
elif [ "${SOURCE_ONLY}" != "1" ]; then
    echo "tails/config/chroot_local-includes/tmp is missing from the full build tree" >&2
    exit 1
fi
swapon_mode="$(stat -c %a tails/config/chroot_local-includes/usr/sbin/swapon.tails)"
if [ "${swapon_mode}" != "755" ]; then
    echo "tails/config/chroot_local-includes/usr/sbin/swapon.tails must be mode 755, got ${swapon_mode}" >&2
    exit 1
fi
if [ -e tails/chroot ] && [ ! -L tails/chroot/sbin ]; then
    echo "tails/chroot/sbin must remain the usrmerge symlink to usr/sbin" >&2
    exit 1
fi
if [ -e tails/chroot ] && [ ! -L tails/chroot/lib ]; then
    echo "tails/chroot/lib must remain the usrmerge symlink to usr/lib" >&2
    exit 1
fi
if [ -e tails/chroot/etc/systemd/system/display-manager.service ]; then
    display_manager_target="$(
        readlink tails/chroot/etc/systemd/system/display-manager.service
    )"
    case "${display_manager_target}" in
        /usr/lib/systemd/system/gdm.service|/usr/lib/systemd/system/gdm3.service) ;;
        *)
            echo "display-manager.service must point at the real /usr/lib GDM unit, got ${display_manager_target}" >&2
            exit 1
            ;;
    esac
fi
grep -q 'clear_user_unit_override' \
    tails/config/chroot_local-includes/usr/local/lib/elizaos/milady-keeper
grep -q 'runuser -u amnesia -- env HOME=/home/amnesia sh -eu' \
    tails/config/chroot_local-includes/usr/local/lib/elizaos/milady-keeper
grep -Fq 'rm -rf -- "${path}"' \
    tails/config/chroot_local-includes/usr/local/lib/elizaos/milady-keeper
if grep -q 'ensure_plain_dir\|install -d -o amnesia\|chown .*amnesia' \
    tails/config/chroot_local-includes/usr/local/lib/elizaos/milady-keeper; then
    echo "milady-keeper must not mutate /home/amnesia paths as root." >&2
    exit 1
fi
grep -q 'systemctl --user start --no-block milady.service' \
    tails/config/chroot_local-includes/usr/local/lib/elizaos/milady-keeper
grep -q 'systemctl --user start --no-block elizaos-agent.service' \
    tails/config/chroot_local-includes/usr/local/lib/elizaos/milady-keeper
grep -q 'systemctl --user start --no-block elizaos-renderer.service' \
    tails/config/chroot_local-includes/usr/local/lib/elizaos/milady-keeper
grep -q 'ELIZA_API_PORT.*:-31337' \
    tails/config/chroot_local-includes/usr/local/lib/elizaos/start-elizaos-agent-user
grep -q 'ELIZAOS_LIVE_EMBEDDING_FALLBACK.*:-1' \
    tails/config/chroot_local-includes/usr/local/lib/elizaos/start-elizaos-agent-user
grep -q 'ELIZA_DISABLE_PROACTIVE_AGENT.*:-1' \
    tails/config/chroot_local-includes/usr/local/lib/elizaos/start-elizaos-agent-user
grep -q 'ELIZA_DISABLE_DIRECT_RUN.*:-1' \
    tails/config/chroot_local-includes/usr/local/lib/elizaos/start-elizaos-agent-user
grep -q 'window.iconify()' \
    tails/config/chroot_local-includes/usr/local/lib/elizaos/elizaos-webkit-shell
grep -q 'ELIZA_WORKSPACE_DIR.*ELIZA_STATE_DIR.*/workspace' \
    tails/config/chroot_local-includes/usr/local/lib/elizaos/start-elizaos-agent-user
grep -Fq 'cd "${ELIZA_WORKSPACE_DIR}"' \
    tails/config/chroot_local-includes/usr/local/lib/elizaos/start-elizaos-agent-user
grep -q 'unset LD_PRELOAD' \
    tails/config/chroot_local-includes/usr/local/lib/elizaos/start-elizaos-agent-user
grep -q 'has_display_env' \
    tails/config/chroot_local-includes/usr/local/lib/elizaos/start-milady-user
grep -q 'exit 75' \
    tails/config/chroot_local-includes/usr/local/lib/elizaos/start-milady-user
grep -q 'ELIZAOS_RENDERER_PORT.*:-5174' \
    tails/config/chroot_local-includes/usr/local/lib/elizaos/start-elizaos-renderer-user
grep -q 'renderer-server.mjs' \
    tails/config/chroot_local-includes/usr/local/lib/elizaos/start-elizaos-renderer-user
grep -q 'ELIZA_DESKTOP_API_BASE.*127.0.0.1' \
    tails/config/chroot_local-includes/usr/local/lib/elizaos/start-elizaos-renderer-user
grep -q '__ELIZAOS_APP_BOOT_CONFIG__' \
    tails/config/chroot_local-includes/usr/local/lib/elizaos/renderer-server.mjs
grep -q 'branding: {' \
    tails/config/chroot_local-includes/usr/local/lib/elizaos/renderer-server.mjs
grep -q 'appName: "elizaOS"' \
    tails/config/chroot_local-includes/usr/local/lib/elizaos/renderer-server.mjs
grep -q 'getAppInfo: () => nativeInfo' \
    tails/config/chroot_local-includes/usr/local/lib/elizaos/renderer-server.mjs
grep -q 'curl --noproxy' \
    tails/config/chroot_local-includes/usr/local/lib/elizaos/start-elizaos-browser-user
grep -q 'elizaos-webkit-shell' \
    tails/config/chroot_local-includes/usr/local/lib/elizaos/start-elizaos-browser-user
grep -q 'ELIZAOS_SHELL_URL' \
    tails/config/chroot_local-includes/usr/local/lib/elizaos/start-elizaos-browser-user
grep -q 'WEBKIT_DISABLE_DMABUF_RENDERER' \
    tails/config/chroot_local-includes/usr/local/lib/elizaos/start-elizaos-browser-user
grep -q 'gi.require_version("Gdk", "3.0")' \
    tails/config/chroot_local-includes/usr/local/lib/elizaos/elizaos-webkit-shell
grep -q 'gi.require_version("WebKit2", "4.1")' \
    tails/config/chroot_local-includes/usr/local/lib/elizaos/elizaos-webkit-shell
grep -q 'set_network_proxy_settings(WebKit2.NetworkProxyMode.NO_PROXY' \
    tails/config/chroot_local-includes/usr/local/lib/elizaos/elizaos-webkit-shell
grep -q 'base_data_directory=data_dir' \
    tails/config/chroot_local-includes/usr/local/lib/elizaos/elizaos-webkit-shell
grep -q 'delete-event' \
    tails/config/chroot_local-includes/usr/local/lib/elizaos/elizaos-webkit-shell
if grep -Eq 'tor-browser|firefox|MOZ_NO_REMOTE|-no-remote|-new-instance' \
    tails/config/chroot_local-includes/usr/local/lib/elizaos/start-elizaos-browser-user; then
    echo "elizaOS app shell must use WebKitGTK, not Tor Browser/Firefox profile launch." >&2
    exit 1
fi
if grep -q 'After=.*desktop.target' \
    tails/config/chroot_local-includes/etc/systemd/user/milady.service; then
    echo "Milady user service must not wait for Tails desktop.target/Tor bootstrap." >&2
    exit 1
fi
if grep -q 'After=.*desktop.target' \
    tails/config/chroot_local-includes/etc/systemd/user/elizaos-agent.service; then
    echo "elizaOS agent service must not wait for Tails desktop.target/Tor bootstrap." >&2
    exit 1
fi
if grep -q 'After=.*desktop.target' \
    tails/config/chroot_local-includes/etc/systemd/user/elizaos-renderer.service; then
    echo "elizaOS renderer service must not wait for Tails desktop.target/Tor bootstrap." >&2
    exit 1
fi
grep -q '^WantedBy=default.target$' \
    tails/config/chroot_local-includes/etc/systemd/user/elizaos-agent.service
grep -q '^WantedBy=default.target$' \
    tails/config/chroot_local-includes/etc/systemd/user/elizaos-renderer.service
grep -q 'Wants=elizaos-renderer.service' \
    tails/config/chroot_local-includes/etc/systemd/user/milady.service
grep -q 'ExecStart=/usr/local/lib/elizaos/start-elizaos-browser-user' \
    tails/config/chroot_local-includes/etc/systemd/user/milady.service
grep -q '^WantedBy=default.target$' \
    tails/config/chroot_local-includes/etc/systemd/user/milady.service
grep -q 'chown root:root' \
    tails/config/chroot_local-hooks/99-zzzzzz_permissions
grep -q '/usr/local/lib/elizaos/capability-runner' \
    tails/config/chroot_local-hooks/99-zzzzzz_permissions
grep -q '/etc/systemd/user/milady.service' \
    tails/config/chroot_local-hooks/99-zzzzzz_permissions
grep -q '/etc/systemd/user/elizaos-agent.service' \
    tails/config/chroot_local-hooks/99-zzzzzz_permissions
grep -q '/etc/systemd/user/elizaos-renderer.service' \
    tails/config/chroot_local-hooks/99-zzzzzz_permissions
grep -q 'systemctl --global enable elizaos-agent.service' \
    tails/config/chroot_local-hooks/52-update-systemd-units
grep -q 'systemctl --global enable elizaos-renderer.service' \
    tails/config/chroot_local-hooks/52-update-systemd-units
if grep -Eq 'apt-(update|install)|restart-network' \
    tails/config/chroot_local-includes/usr/local/lib/elizaos/capability-runner; then
    echo "capability-runner must not expose broad package/network mutation commands" >&2
    exit 1
fi
grep -q 'args = \["root-status"\]' \
    tails/config/chroot_local-includes/etc/generate-sudoers.d/elizaos-capability-runner.toml

if [ -e tails/config/chroot_local-includes/usr/share/elizaos/milady-app/Resources/build.json ]; then
    echo "==> Milady live overlay"
    node scripts/prepare-milady-app-overlay.mjs --check
fi

echo "==> Milady package exports"
node - <<'NODE'
const fs = require("fs");

for (const root of [
  "tails/config/chroot_local-includes/usr/share/elizaos/milady-app",
  "tails/chroot/opt/milady",
]) {
  if (!fs.existsSync(root)) continue;

  const versionPath = `${root}/Resources/version.json`;
  const version = JSON.parse(fs.readFileSync(versionPath, "utf8"));
  if (version.name !== "elizaOS") {
    throw new Error(`${versionPath}: name must be elizaOS`);
  }
  if (version.identifier !== "ai.elizaos.app") {
    throw new Error(`${versionPath}: identifier must be ai.elizaos.app`);
  }

  const brandPath = `${root}/Resources/app/brand-config.json`;
  const brand = JSON.parse(fs.readFileSync(brandPath, "utf8"));
  for (const [key, expected] of Object.entries({
    appName: "elizaOS",
    appId: "ai.elizaos.app",
    namespace: "eliza",
    urlScheme: "elizaos",
    configDirName: "elizaOS",
  })) {
    if (brand[key] !== expected) {
      throw new Error(`${brandPath}: ${key} must be ${expected}`);
    }
  }
}

for (const path of [
  "tails/config/chroot_local-includes/usr/share/elizaos/milady-app/Resources/app/eliza-dist/node_modules/@elizaos/agent/package.json",
  "tails/chroot/opt/milady/Resources/app/eliza-dist/node_modules/@elizaos/agent/package.json",
]) {
  if (!fs.existsSync(path)) continue;
  const pkg = JSON.parse(fs.readFileSync(path, "utf8"));
  const target = pkg.exports?.["./services/permissions/probers/index"];
  if (
    target?.import !==
    "./dist/packages/agent/src/services/permissions/probers/index.js"
  ) {
    throw new Error(
      `${path}: missing packaged permissions prober export required by Electrobun`,
    );
  }
}

for (const [path, target] of [
  [
    "tails/config/chroot_local-includes/usr/share/elizaos/milady-app/node_modules",
    "Resources/app/eliza-dist/node_modules",
  ],
  [
    "tails/config/chroot_local-includes/usr/share/elizaos/milady-app/bin/node_modules",
    "../Resources/app/eliza-dist/node_modules",
  ],
  ["tails/chroot/opt/milady/node_modules", "Resources/app/eliza-dist/node_modules"],
  [
    "tails/chroot/opt/milady/bin/node_modules",
    "../Resources/app/eliza-dist/node_modules",
  ],
]) {
  if (!fs.existsSync(path)) continue;
  const actual = fs.readlinkSync(path);
  if (actual !== target) {
    throw new Error(`${path}: expected symlink to ${target}, got ${actual}`);
  }
}

for (const packageName of [
  "@elizaos/plugin-whatsapp",
  "@elizaos/plugin-streaming",
  "@elizaos/plugin-x402",
  "@elizaos/plugin-mcp",
  "@elizaos/plugin-imessage",
  "@elizaos/plugin-capacitor-bridge",
  "@elizaos/plugin-aosp-local-inference",
  "@elizaos/plugin-background-runner",
  "@elizaos/plugin-mlx",
]) {
  for (const root of [
    "tails/config/chroot_local-includes/usr/share/elizaos/milady-app",
    "tails/chroot/opt/milady",
  ]) {
    if (!fs.existsSync(root)) continue;
    const packagePath = `${root}/Resources/app/eliza-dist/node_modules/${packageName}/package.json`;
    const indexPath = `${root}/Resources/app/eliza-dist/node_modules/${packageName}/index.js`;
    const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
    if (pkg.version === "0.0.0-elizaos-live-stub") {
      if (pkg.type !== "module") {
        throw new Error(`${packagePath}: optional desktop connector stub must be ESM`);
      }
      const index = fs.readFileSync(indexPath, "utf8");
      if (!index.includes("export default undefined")) {
        throw new Error(`${indexPath}: optional desktop connector stub is malformed`);
      }
    }
  }
}

for (const root of [
  "tails/config/chroot_local-includes/usr/share/elizaos/milady-app",
  "tails/chroot/opt/milady",
]) {
  if (!fs.existsSync(root)) continue;
  const nodeModules = `${root}/Resources/app/eliza-dist/node_modules`;
  const orchestratorIndex = `${nodeModules}/agent-orchestrator/index.js`;
  const orchestrator = fs.readFileSync(orchestratorIndex, "utf8");
  if (!orchestrator.includes("ELIZAOS") || !orchestrator.includes("capability-runner")) {
    throw new Error(`${orchestratorIndex}: missing live OS broker action`);
  }
  const appControlPackagePath = `${nodeModules}/@elizaos/plugin-app-control/package.json`;
  const appControlPackage = JSON.parse(fs.readFileSync(appControlPackagePath, "utf8"));
  if (appControlPackage.main !== "./src/index.ts") {
    throw new Error(`${appControlPackagePath}: app-control must be source-staged`);
  }
  for (const packageName of [
    "@elizaos/plugin-calendly",
    "@elizaos/plugin-health",
  ]) {
    const distIndex = `${nodeModules}/${packageName}/dist/index.js`;
    if (!fs.existsSync(distIndex)) {
      throw new Error(`${distIndex}: required runtime plugin dist is missing`);
    }
  }
  const googleStubPath = `${nodeModules}/@elizaos/plugin-google/index.js`;
  const googlePackagePath = `${nodeModules}/@elizaos/plugin-google/package.json`;
  const googlePackage = JSON.parse(fs.readFileSync(googlePackagePath, "utf8"));
  if (googlePackage.version === "0.0.0-elizaos-live-stub") {
    const googleStub = fs.readFileSync(googleStubPath, "utf8");
    if (!googleStub.includes("googlePlugin")) {
      throw new Error(`${googleStubPath}: Google connector stub is malformed`);
    }
  }

  const rendererRoot = `${root}/Resources/app/renderer`;
  const indexPath = `${rendererRoot}/index.html`;
  const manifestPath = `${rendererRoot}/site.webmanifest`;
  const wallpaperPath = "tails/config/chroot_local-includes/usr/share/tails/desktop_wallpaper.png";
  if (fs.existsSync(indexPath)) {
    const index = fs.readFileSync(indexPath, "utf8");
    if (!index.includes("<title>elizaOS</title>")) {
      throw new Error(`${indexPath}: browser shell title must be elizaOS`);
    }
    if (index.includes("<title>Milady</title>") || index.includes("app.milady.ai")) {
      throw new Error(`${indexPath}: browser shell metadata still contains Milady branding`);
    }
  }
  if (fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (manifest.name !== "elizaOS" || manifest.short_name !== "elizaOS") {
      throw new Error(`${manifestPath}: web manifest must be branded elizaOS`);
    }
  }
  for (const name of ["splash-bg.png", "splash-bg-dark.png", "og-image.png"]) {
    const imagePath = `${rendererRoot}/${name}`;
    if (
      fs.existsSync(imagePath) &&
      fs.existsSync(wallpaperPath) &&
      Buffer.compare(fs.readFileSync(imagePath), fs.readFileSync(wallpaperPath)) !== 0
    ) {
      throw new Error(`${imagePath}: renderer splash image must use the elizaOS wallpaper`);
    }
  }
  for (const file of fs.readdirSync(`${rendererRoot}/assets`).filter((name) => name.endsWith(".js"))) {
    const text = fs.readFileSync(`${rendererRoot}/assets/${file}`, "utf8");
    const forbidden = [
      "WELCOME TO MILADY",
      "Welcome to Milady",
      "Milady's HTTP API",
      'appName:"Milady"',
      'orgName:"milady-ai"',
      'repoName:"milady"',
      'cliName:"milady"',
      'envPrefix:"MILADY"',
      'namespace:"milady"',
      'urlScheme:"milady"',
      'docsUrl:"https://docs.milady.ai"',
      'appUrl:"https://app.milady.ai"',
      'hashtag:"#MiladyAgent"',
      'fileExtension:".milady-agent"',
      'packageScope:"miladyai"',
      "milady.zone",
    ];
    for (const needle of forbidden) {
      if (text.includes(needle)) {
        throw new Error(`${rendererRoot}/assets/${file}: visible Milady launch branding remains: ${needle}`);
      }
    }
  }
}

for (const root of [
  "tails/config/chroot_local-includes/usr/share/elizaos/milady-app",
  "tails/chroot/opt/milady",
]) {
  if (!fs.existsSync(root)) continue;
  const lucidePackagePath = `${root}/Resources/app/eliza-dist/node_modules/lucide-react/package.json`;
  const lucideIndexPath = `${root}/Resources/app/eliza-dist/node_modules/lucide-react/index.js`;
  const lucidePackage = JSON.parse(fs.readFileSync(lucidePackagePath, "utf8"));
  if (lucidePackage.version === "0.0.0-elizaos-live-stub") {
    const lucideIndex = fs.readFileSync(lucideIndexPath, "utf8");
    for (const expected of [
      "export function Icon()",
      "export const createLucideIcon",
      "export const Feather",
      "export const Loader2",
      "export const Maximize2",
      "export const Settings",
    ]) {
      if (!lucideIndex.includes(expected)) {
        throw new Error(`${lucideIndexPath}: missing ${expected}`);
      }
    }
  }

  const coreIndexPath = `${root}/Resources/app/eliza-dist/node_modules/@elizaos/core/src/index.node.ts`;
  if (fs.existsSync(coreIndexPath)) {
    const coreIndex = fs.readFileSync(coreIndexPath, "utf8");
    if (coreIndex.includes('export * from "./testing";')) {
      throw new Error(`${coreIndexPath}: production runtime must not export @elizaos/core testing helpers`);
    }
  }

  const localInferenceIndexPath = `${root}/Resources/app/eliza-dist/node_modules/@elizaos/plugin-local-inference/dist/index.js`;
  const localInferenceRuntimePath = `${root}/Resources/app/eliza-dist/node_modules/@elizaos/plugin-local-inference/dist/runtime/index.js`;
  for (const path of [localInferenceIndexPath, localInferenceRuntimePath]) {
    if (!fs.existsSync(path)) continue;
    const text = fs.readFileSync(path, "utf8");
    if (!text.includes("ELIZAOS_LIVE_EMBEDDING_FALLBACK")) {
      throw new Error(`${path}: missing elizaOS Live embedding fallback gate`);
    }
  }

  const bunIndexPath = `${root}/Resources/app/bun/index.js`;
  const bunIndex = fs.readFileSync(bunIndexPath, "utf8");
  for (const expected of [
    "ELIZAOS_CLOSE_MINIMIZES_TO_TRAY",
    "Window close requested - minimized to tray",
    "await this.hideWindow()",
  ]) {
    if (!bunIndex.includes(expected)) {
      throw new Error(`${bunIndexPath}: missing close-to-tray behavior: ${expected}`);
    }
  }
}
NODE

if [ -e tails/chroot/opt/milady/Resources/build.json ]; then
    echo "==> Milady installed app config"
    node -e '
const fs = require("fs");
const path = "tails/chroot/opt/milady/Resources/build.json";
const build = JSON.parse(fs.readFileSync(path, "utf8"));
if (build.defaultRenderer !== "native") {
  throw new Error(`${path}: defaultRenderer must be native for elizaOS Live`);
}
if (JSON.stringify(build.availableRenderers) !== JSON.stringify(["native"])) {
  throw new Error(`${path}: availableRenderers must be [\"native\"] for elizaOS Live`);
}
if (build.runtime?.exitOnLastWindowClosed !== false) {
  throw new Error(`${path}: runtime.exitOnLastWindowClosed must be false`);
}
if (build.runtime?.closeMinimizesToTray !== true) {
  throw new Error(`${path}: runtime.closeMinimizesToTray must be true`);
}
if (
  build.chromiumFlags?.["user-data-dir"] !==
  "/home/amnesia/.cache/ai.elizaos.app/dev/CEF/partitions"
) {
  throw new Error(`${path}: Chromium user-data-dir must target the CEF partitions symlink`);
}
	'
fi
if [ -e tails/chroot/opt/milady/bin/chrome-sandbox ]; then
    sandbox_mode="$(stat -c %a tails/chroot/opt/milady/bin/chrome-sandbox)"
    if [ "${sandbox_mode}" != "755" ]; then
        echo "chrome-sandbox must not be setuid in native-renderer elizaOS Live, got ${sandbox_mode}" >&2
        exit 1
    fi
fi

if command -v xmllint >/dev/null 2>&1; then
    echo "==> XML"
    xmllint --noout \
        tails/config/chroot_local-includes/usr/share/tails/persistent-storage/features_view.ui.in \
        tails/config/chroot_local-includes/usr/share/tails/greeter/main.ui.in
else
    echo "skip: xmllint not installed"
fi

echo "==> Python compile"
python3 -m py_compile \
    tails/config/chroot_local-includes/usr/lib/python3/dist-packages/tps/configuration/features.py \
    tails/config/chroot_local-includes/usr/lib/python3/dist-packages/tps_frontend/views/features_view.py
find tails/config/chroot_local-includes/usr/lib/python3/dist-packages \
    -type d -name __pycache__ -prune -exec rm -rf {} +

if [ "${ELIZAOS_STATIC_TSC:-0}" = "1" ] && [ -x "${REPO_ROOT}/node_modules/.bin/tsc" ]; then
    echo "==> orchestrator TypeScript"
    (cd "${REPO_ROOT}" && nice -n 19 node_modules/.bin/tsc --noEmit \
        -p plugins/plugin-agent-orchestrator/tsconfig.json --pretty false)
fi

echo "==> diff whitespace"
git -C "${REPO_ROOT}" diff --check -- \
    packages/os/linux/variants/milady-tails \
    plugins/plugin-agent-orchestrator/src/actions/elizaos-capability.ts \
    plugins/plugin-agent-orchestrator/src/index.ts \
    plugins/plugin-agent-orchestrator/src/services/acp-service.ts \
    plugins/plugin-agent-orchestrator/src/services/pty-spawn.ts

echo "static smoke passed"
