#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$ROOT/../.." && pwd)"
RM_PATH_RECURSIVE="$REPO_ROOT/scripts/rm-path-recursive.ts"
TMP_DIR="$(mktemp -d)"
cleanup() {
  node "$RM_PATH_RECURSIVE" "$TMP_DIR"
}
trap cleanup EXIT

pass() {
  echo "ok - $*"
}

fail() {
  echo "not ok - $*" >&2
  exit 1
}

assert_contains() {
  local file="$1"
  local needle="$2"
  grep -Fq -- "$needle" "$file" || {
    echo "missing expected text: $needle" >&2
    echo "--- output ---" >&2
    sed -n '1,200p' "$file" >&2
    fail "assert_contains failed"
  }
}

BIN_DIR="$TMP_DIR/bin"
ARTIFACT_DIR="$TMP_DIR/artifacts"
mkdir -p "$BIN_DIR" "$ARTIFACT_DIR"
printf 'boot-image-fixture\n' >"$ARTIFACT_DIR/boot.img"
printf 'vendor-boot-image-fixture\n' >"$ARTIFACT_DIR/vendor_boot.img"
printf 'vendor-kernel-boot-image-fixture\n' >"$ARTIFACT_DIR/vendor_kernel_boot.img"
printf 'super-image-fixture\n' >"$ARTIFACT_DIR/super.img"

cat >"$BIN_DIR/adb" <<'EOF'
#!/usr/bin/env bash
case "$*" in
  *"devices -l"*) printf 'List of devices attached\nTEST123 device usb:1-1 product:test model:Test device:tegu\n' ;;
  *"get-state"*) echo device ;;
  *"getprop ro.product.device"*) echo tegu ;;
  *"getprop ro.build.fingerprint"*) echo 'elizaOS/eliza_tegu_phone/tegu:15/example:userdebug/test-keys' ;;
  *"getprop ro.boot.slot_suffix"*) echo '_a' ;;
  *"getprop sys.boot_completed"*) echo "${FAKE_BOOT_COMPLETED:-1}" ;;
  *"pm path ai.elizaos.app"*) echo 'package:/system/priv-app/Eliza/Eliza.apk' ;;
  *"cmd role get-role-holders android.app.role.HOME"*) echo 'ai.elizaos.app' ;;
  *"cmd package resolve-activity"*) echo 'ai.elizaos.app/.MainActivity' ;;
  *"dumpsys package ai.elizaos.app"*) echo 'Package [ai.elizaos.app]' ;;
  *"dumpsys activity activities"*) echo 'mResumedActivity: ai.elizaos.app/.MainActivity' ;;
  *"pidof ai.elizaos.app"*) echo 31337 ;;
  *"toybox nc -w 5 127.0.0.1 31337"*)
    if [[ "${FAKE_AGENT_HEALTH_STATUS:-200}" == 200 ]]; then
      health_body="${FAKE_AGENT_HEALTH_BODY:-}"
      [[ -n "$health_body" ]] || health_body='{"status":"ready","agentId":"fixture"}'
      printf 'HTTP/1.0 200 OK\r\nContent-Type: application/json\r\n\r\n%s\n' \
        "$health_body"
    else
      printf 'HTTP/1.0 %s Unavailable\r\nContent-Type: application/json\r\n\r\n{"status":"unhealthy"}\n' "$FAKE_AGENT_HEALTH_STATUS"
    fi
    ;;
  *"logcat -d"*) [[ "${FAKE_LOGCAT_FAIL:-0}" == 0 ]] || exit 1; echo 'logcat clean' ;;
  *"settings get global adb_enabled"*) echo 1 ;;
  *) echo "fake adb $*" ;;
esac
EOF

cat >"$BIN_DIR/fastboot" <<'EOF'
#!/usr/bin/env bash
case "$*" in
  *"devices"*) printf 'test-device\tfastboot\n' ;;
  *"getvar unlocked"*) echo 'unlocked: yes' >&2 ;;
  *"getvar product"*) echo 'product: tegu' >&2 ;;
  *) echo "fake fastboot $*" ;;
esac
EOF

cat >"$BIN_DIR/timeout" <<'EOF'
#!/usr/bin/env bash
shift
exec "$@"
EOF

chmod +x "$BIN_DIR/adb" "$BIN_DIR/fastboot" "$BIN_DIR/timeout"
export PATH="$BIN_DIR:$PATH"

INSTALL_OUT="$TMP_DIR/install.out"
"$ROOT/install-elizaos-android.sh" --artifact-dir "$ARTIFACT_DIR" >"$INSTALL_OUT"
assert_contains "$INSTALL_OUT" "Dry-run only. No commands were executed."
assert_contains "$INSTALL_OUT" "fastboot flash boot"
assert_contains "$INSTALL_OUT" "fastboot flash vendor_boot"
assert_contains "$INSTALL_OUT" "fastboot flash vendor_kernel_boot"
assert_contains "$INSTALL_OUT" "fastboot flash super"
pass "installer dry-run plans discovered images"

SLOT_OUT="$TMP_DIR/slot.out"
"$ROOT/install-elizaos-android.sh" --artifact-dir "$ARTIFACT_DIR" --slot a >"$SLOT_OUT"
assert_contains "$SLOT_OUT" "fastboot flash --slot a boot"
assert_contains "$SLOT_OUT" "fastboot --set-active=a"
assert_contains "$SLOT_OUT" "fastboot getvar current-slot"
pass "installer pins the flashed slot active"

INVALID_SLOT_OUT="$TMP_DIR/invalid-slot.out"
if "$ROOT/install-elizaos-android.sh" --artifact-dir "$ARTIFACT_DIR" --slot c >"$INVALID_SLOT_OUT" 2>&1; then
  fail "installer accepted an invalid slot"
fi
assert_contains "$INVALID_SLOT_OUT" "--slot must be 'a' or 'b'"
pass "installer rejects invalid slots"

STALE_ARTIFACT_DIR="$TMP_DIR/artifacts-stale"
mkdir -p "$STALE_ARTIFACT_DIR"
cp "$ARTIFACT_DIR/boot.img" "$STALE_ARTIFACT_DIR/boot.img"
cp "$ARTIFACT_DIR/vendor_boot.img" "$STALE_ARTIFACT_DIR/vendor_boot.img"
touch -t 202001010000 "$STALE_ARTIFACT_DIR/vendor_boot.img"
STALE_OUT="$TMP_DIR/stale.out"
if "$ROOT/install-elizaos-android.sh" --artifact-dir "$STALE_ARTIFACT_DIR" >"$STALE_OUT" 2>&1; then
  fail "installer accepted an artifact dir mixing build generations"
fi
assert_contains "$STALE_OUT" "mixes build generations"
STALE_OVERRIDE_OUT="$TMP_DIR/stale-override.out"
"$ROOT/install-elizaos-android.sh" --artifact-dir "$STALE_ARTIFACT_DIR" --allow-stale-artifacts >"$STALE_OVERRIDE_OUT"
assert_contains "$STALE_OVERRIDE_OUT" "Dry-run only. No commands were executed."
pass "installer refuses mixed-generation artifact dirs"

ANDROID_INFO_FILE="$TMP_DIR/android-info.txt"
cat >"$ANDROID_INFO_FILE" <<'INFO'
require board=tegu
require version-bootloader=fixture-bl-1.0
require partition-exists=vendor_kernel_boot
INFO
cat >"$BIN_DIR/fastboot" <<'EOF'
#!/usr/bin/env bash
case "$*" in
  *"devices"*) printf '%b' "${FAKE_FASTBOOT_INVENTORY-test-device\tfastboot\n}" ;;
  *"getvar unlocked"*) echo '(bootloader) unlocked:yes' >&2 ;;
  *"getvar product"*) echo 'product: tegu' >&2 ;;
  *"getvar version-bootloader"*) echo "version-bootloader: ${FAKE_BOOTLOADER_VERSION:-fixture-bl-1.0}" >&2 ;;
  *"getvar partition-size:vendor_kernel_boot"*) echo 'partition-size:vendor_kernel_boot: 0x1000000' >&2 ;;
  *) echo "fake fastboot $*" ;;
esac
EOF
chmod +x "$BIN_DIR/fastboot"
ANDROID_INFO_OUT="$TMP_DIR/android-info.out"
"$ROOT/install-elizaos-android.sh" \
  --artifact-dir "$ARTIFACT_DIR" \
  --android-info "$ANDROID_INFO_FILE" \
  --assume-bootloader --execute >"$ANDROID_INFO_OUT"
assert_contains "$ANDROID_INFO_OUT" "execution requested without --confirm-flash"
ANDROID_INFO_MISMATCH_OUT="$TMP_DIR/android-info-mismatch.out"
if FAKE_BOOTLOADER_VERSION=other-bl-9.9 "$ROOT/install-elizaos-android.sh" \
  --artifact-dir "$ARTIFACT_DIR" \
  --android-info "$ANDROID_INFO_FILE" \
  --assume-bootloader --execute >"$ANDROID_INFO_MISMATCH_OUT" 2>&1; then
  fail "installer accepted a mismatched bootloader version"
fi
assert_contains "$ANDROID_INFO_MISMATCH_OUT" "requires 'fixture-bl-1.0'"
pass "installer enforces android-info firmware requirements"

assert_contains "$ANDROID_INFO_OUT" "fastboot -s test-device flash"
for inventory in '' 'other\tfastboot\n' 'test-device\tROM Recovery\n'; do
  if FAKE_FASTBOOT_INVENTORY="$inventory" "$ROOT/install-elizaos-android.sh" --artifact-dir "$ARTIFACT_DIR" --device test-device --assume-bootloader --execute >"$TMP_DIR/inventory-refusal.out" 2>&1; then
    fail "installer accepted an absent or early-recovery target"
  fi
  assert_contains "$TMP_DIR/inventory-refusal.out" "requested device is not in normal fastboot mode"
done
if FAKE_FASTBOOT_INVENTORY='first\tfastboot\nsecond\tfastboot\n' "$ROOT/install-elizaos-android.sh" --artifact-dir "$ARTIFACT_DIR" --assume-bootloader --execute >"$TMP_DIR/ambiguous.out" 2>&1; then
  fail "installer accepted ambiguous fastboot devices"
fi
assert_contains "$TMP_DIR/ambiguous.out" "expected exactly one normal fastboot device"
pass "installer pins plans and rejects ambiguous, absent, and ROM-recovery targets"

MODE_MANIFEST="$TMP_DIR/mode-manifest.json"
node - "$ROOT/manifests/android-release-manifest.example.json" "$MODE_MANIFEST" <<'NODE'
const { readFileSync, writeFileSync } = require('node:fs');
const [source, target] = process.argv.slice(2);
const manifest = JSON.parse(readFileSync(source, 'utf8'));
writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
MODE_OUT="$TMP_DIR/mode.out"
"$ROOT/install-elizaos-android.sh" \
  --artifact-dir "$ARTIFACT_DIR" \
  --manifest "$MODE_MANIFEST" >"$MODE_OUT"
assert_contains "$MODE_OUT" "fastboot reboot fastboot"
pass "installer honors manifest fastbootd mode transitions"

FLASH_REFUSAL_OUT="$TMP_DIR/flash-refusal.out"
if "$ROOT/install-elizaos-android.sh" \
  --artifact-dir "$ARTIFACT_DIR" \
  --execute --confirm-flash >"$FLASH_REFUSAL_OUT" 2>&1; then
  fail "installer accepted a flash without a release manifest"
fi
assert_contains "$FLASH_REFUSAL_OUT" "--confirm-flash requires --manifest"
pass "installer refuses unmanifested flashing"

CANDIDATE_REFUSAL_OUT="$TMP_DIR/candidate-refusal.out"
if "$ROOT/install-elizaos-android.sh" \
  --artifact-dir "$ARTIFACT_DIR" \
  --manifest "$ROOT/manifests/android-release-manifest.example.json" \
  --execute --confirm-flash >"$CANDIDATE_REFUSAL_OUT" 2>&1; then
  fail "installer accepted a non-lab-validated device manifest"
fi
assert_contains "$CANDIDATE_REFUSAL_OUT" "legacy manifests are planning-only"
pass "installer refuses candidate-only hardware manifests"

VALIDATE_OUT="$TMP_DIR/validate.out"
"$REPO_ROOT/scripts/android-installer/validate-post-flash.sh" \
  --device TEST123 \
  --manifest "$ROOT/manifests/android-release-manifest.example.json" \
  >"$VALIDATE_OUT"
assert_contains "$VALIDATE_OUT" "Dry-run only. No ADB commands were executed."
assert_contains "$VALIDATE_OUT" "ro.product.device=tegu"
assert_contains "$VALIDATE_OUT" "ro.build.fingerprint^=elizaOS/eliza_tegu_phone/tegu:"
pass "post-flash validator dry-run reads manifest expectations"

VALIDATE_EXEC_OUT="$TMP_DIR/validate-exec.out"
"$REPO_ROOT/scripts/android-installer/validate-post-flash.sh" \
  --device TEST123 \
  --manifest "$ROOT/manifests/android-release-manifest.example.json" \
  --execute \
  >"$VALIDATE_EXEC_OUT"
assert_contains "$VALIDATE_EXEC_OUT" "+ adb -s TEST123 get-state"
assert_contains "$VALIDATE_EXEC_OUT" "cmd role get-role-holders android.app.role.HOME"
assert_contains "$VALIDATE_EXEC_OUT" "toybox nc -w 5 127.0.0.1 31337"
if grep -Fq "shell curl" "$VALIDATE_EXEC_OUT"; then
  fail "post-flash validator still depends on an on-device curl binary"
fi
pass "post-flash validator execute path works with fake adb"

for boot_state in 0 unknown; do
  if FAKE_BOOT_COMPLETED="$boot_state" "$REPO_ROOT/scripts/android-installer/validate-post-flash.sh" \
    --device TEST123 --execute >"$TMP_DIR/boot-incomplete.out" 2>&1; then
    fail "post-flash validator accepted incomplete boot without a manifest"
  fi
  assert_contains "$TMP_DIR/boot-incomplete.out" "Android boot is incomplete"
done
pass "post-flash validation requires boot completion even without a manifest"

UNHEALTHY_OUT="$TMP_DIR/validate-unhealthy.out"
if FAKE_AGENT_HEALTH_STATUS=503 "$REPO_ROOT/scripts/android-installer/validate-post-flash.sh" \
  --device TEST123 \
  --manifest "$ROOT/manifests/android-release-manifest.example.json" \
  --execute >"$UNHEALTHY_OUT" 2>&1; then
  fail "post-flash validator accepted a non-200 agent health response"
fi
assert_contains "$UNHEALTHY_OUT" "agent health probe did not return HTTP 200"
pass "post-flash validator rejects unhealthy HTTP status"

UNHEALTHY_BODY_OUT="$TMP_DIR/validate-unhealthy-body.out"
if FAKE_AGENT_HEALTH_BODY='{"status":"unhealthy"}' "$REPO_ROOT/scripts/android-installer/validate-post-flash.sh" \
  --device TEST123 \
  --manifest "$ROOT/manifests/android-release-manifest.example.json" \
  --execute >"$UNHEALTHY_BODY_OUT" 2>&1; then
  fail "post-flash validator accepted an unhealthy HTTP 200 agent response body"
fi
assert_contains "$UNHEALTHY_BODY_OUT" "agent health probe body did not return ready/ok/healthy"
pass "post-flash validator rejects unhealthy HTTP 200 body"

for body in '{"status":"ready"' '{"nested":{"status":"ready"}}' \
  '[{"status":"ready"}]' '{"status":"ready","ready":false}' \
  '{"status":"ready"} trailing' $'{"status":"rea\rdy"}'; do
  if FAKE_AGENT_HEALTH_BODY="$body" "$REPO_ROOT/scripts/android-installer/validate-post-flash.sh" \
    --device TEST123 --execute >"$TMP_DIR/invalid-health.out" 2>&1; then
    fail "post-flash validator accepted malformed or non-ready health JSON"
  fi
  assert_contains "$TMP_DIR/invalid-health.out" "agent health probe body did not return"
done
pass "post-flash validator parses top-level health JSON and respects readiness"

# Execute the actual generated remote printf through a fake toybox. This checks
# request bytes, not merely whether the printed plan contains the URL.
cat >"$BIN_DIR/toybox" <<'EOF'
#!/usr/bin/env bash
cat >"$HEALTH_REQUEST_FILE"
printf 'HTTP/1.0 200 OK\r\n\r\n{"status":"ready"}\n'
EOF
chmod +x "$BIN_DIR/toybox"
export HEALTH_REQUEST_FILE="$TMP_DIR/health-request"
# Delegate only the health shell command to the local fixture shell.
cp "$BIN_DIR/adb" "$BIN_DIR/adb-fixture"
cat >"$BIN_DIR/adb" <<'EOF'
#!/usr/bin/env bash
if [[ "$*" == *"toybox nc"* ]]; then
  exec bash -c "${@: -1}"
fi
exec "$(dirname "$0")/adb-fixture" "$@"
EOF
"$REPO_ROOT/scripts/android-installer/validate-post-flash.sh" \
  --device TEST123 --agent-health-url 'http://127.0.0.1:03137/api/health?path=%2F&count=%s' \
  --execute >"$TMP_DIR/encoded-health.out"
assert_contains "$HEALTH_REQUEST_FILE" 'GET /api/health?path=%2F&count=%s HTTP/1.0'
assert_contains "$HEALTH_REQUEST_FILE" 'Host: 127.0.0.1:3137'
mv "$BIN_DIR/adb-fixture" "$BIN_DIR/adb"
pass "post-flash health requests preserve percent escapes and parse decimal ports"

UNSAFE_HEALTH_OUT="$TMP_DIR/validate-unsafe-health-url.out"
if "$REPO_ROOT/scripts/android-installer/validate-post-flash.sh" \
  --agent-health-url https://example.com/api/health \
  >"$UNSAFE_HEALTH_OUT" 2>&1; then
  fail "post-flash validator accepted a non-local agent health URL"
fi
assert_contains "$UNSAFE_HEALTH_OUT" "must be an explicit http://127.0.0.1:PORT/PATH endpoint"
pass "post-flash validator rejects non-local health endpoints"

MANIFEST_OUT="$TMP_DIR/manifest.out"
node "$REPO_ROOT/scripts/android-installer/validate-release-manifest.ts" \
  "$ROOT/manifests/android-release-manifest.example.json" \
  >"$MANIFEST_OUT"
assert_contains "$MANIFEST_OUT" "manifest ok: elizaos-android-example-2026.05.0"
pass "manifest validator accepts example manifest"

INELIGIBLE_MANIFEST="$TMP_DIR/ineligible-lab-manifest.json"
node - "$ROOT/manifests/android-release-manifest.example.json" "$INELIGIBLE_MANIFEST" <<'NODE'
const { readFileSync, writeFileSync } = require('node:fs');
const [source, target] = process.argv.slice(2);
const manifest = JSON.parse(readFileSync(source, 'utf8'));
manifest.supportedDevices[0].tier = 'lab-validated';
writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
INELIGIBLE_OUT="$TMP_DIR/ineligible-lab.out"
if node "$REPO_ROOT/scripts/android-installer/validate-release-manifest.ts" \
  "$INELIGIBLE_MANIFEST" >"$INELIGIBLE_OUT" 2>&1; then
  fail "manifest validator promoted an installer-ineligible hardware target"
fi
assert_contains "$INELIGIBLE_OUT" "cannot be lab-validated while this target is installer-ineligible"
pass "manifest validator refuses inventory-bypassing lab promotion"

INCOMPLETE_EVIDENCE_MANIFEST="$TMP_DIR/incomplete-evidence-manifest.json"
node - "$ROOT/manifests/android-release-manifest.example.json" "$INCOMPLETE_EVIDENCE_MANIFEST" <<'NODE'
const { readFileSync, writeFileSync } = require('node:fs');
const [source, target] = process.argv.slice(2);
const manifest = JSON.parse(readFileSync(source, 'utf8'));
manifest.validation.requiredValidationTokens = ['pm path'];
manifest.buildFingerprint = 'elizaOS/wrong/tegu:15/example:userdebug/test-keys';
delete manifest.rollback.previousReleaseId;
writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
INCOMPLETE_EVIDENCE_OUT="$TMP_DIR/incomplete-evidence.out"
if node "$REPO_ROOT/scripts/android-installer/validate-release-manifest.ts" \
  "$INCOMPLETE_EVIDENCE_MANIFEST" >"$INCOMPLETE_EVIDENCE_OUT" 2>&1; then
  fail "manifest validator accepted incomplete runtime/rollback evidence"
fi
assert_contains "$INCOMPLETE_EVIDENCE_OUT" 'must include "cmd role get-role-holders"'
assert_contains "$INCOMPLETE_EVIDENCE_OUT" "must start with elizaOS/eliza_tegu_phone/tegu:"
assert_contains "$INCOMPLETE_EVIDENCE_OUT" "must identify a retained known-good release"
pass "manifest validator enforces runtime and rollback evidence contracts"

HASH_BOOT="$(node -e "const {createHash}=require('node:crypto'); const {readFileSync}=require('node:fs'); process.stdout.write(createHash('sha256').update(readFileSync(process.argv[1])).digest('hex'))" "$ARTIFACT_DIR/boot.img")"
HASH_VENDOR_BOOT="$(node -e "const {createHash}=require('node:crypto'); const {readFileSync}=require('node:fs'); process.stdout.write(createHash('sha256').update(readFileSync(process.argv[1])).digest('hex'))" "$ARTIFACT_DIR/vendor_boot.img")"
HASH_VENDOR_KERNEL_BOOT="$(node -e "const {createHash}=require('node:crypto'); const {readFileSync}=require('node:fs'); process.stdout.write(createHash('sha256').update(readFileSync(process.argv[1])).digest('hex'))" "$ARTIFACT_DIR/vendor_kernel_boot.img")"
HASH_SUPER="$(node -e "const {createHash}=require('node:crypto'); const {readFileSync}=require('node:fs'); process.stdout.write(createHash('sha256').update(readFileSync(process.argv[1])).digest('hex'))" "$ARTIFACT_DIR/super.img")"
ARTIFACT_MANIFEST="$TMP_DIR/release-manifest.json"
node - "$ROOT/manifests/android-release-manifest.example.json" "$ARTIFACT_MANIFEST" "$HASH_BOOT" "$HASH_VENDOR_BOOT" "$HASH_VENDOR_KERNEL_BOOT" "$HASH_SUPER" <<'NODE'
const { readFileSync, writeFileSync } = require('node:fs');
const [source, target, bootHash, vendorBootHash, vendorKernelBootHash, superHash] = process.argv.slice(2);
const manifest = JSON.parse(readFileSync(source, 'utf8'));
manifest.artifacts[0].sha256 = bootHash;
manifest.artifacts[1].sha256 = vendorBootHash;
manifest.artifacts[2].sha256 = vendorKernelBootHash;
manifest.artifacts[3].sha256 = superHash;
writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`);
NODE

ARTIFACT_VALIDATE_OUT="$TMP_DIR/artifact-validate.out"
node "$REPO_ROOT/scripts/android-installer/validate-release-manifest.ts" \
  "$ARTIFACT_MANIFEST" \
  --artifact-dir "$ARTIFACT_DIR" \
  >"$ARTIFACT_VALIDATE_OUT"
assert_contains "$ARTIFACT_VALIDATE_OUT" "artifacts ok: $ARTIFACT_DIR"
pass "manifest validator checks artifact size and hashes"

EXTRA_ARTIFACT_DIR="$TMP_DIR/artifacts-with-extra-image"
mkdir -p "$EXTRA_ARTIFACT_DIR"
cp "$ARTIFACT_DIR/boot.img" "$EXTRA_ARTIFACT_DIR/boot.img"
cp "$ARTIFACT_DIR/vendor_boot.img" "$EXTRA_ARTIFACT_DIR/vendor_boot.img"
cp "$ARTIFACT_DIR/vendor_kernel_boot.img" "$EXTRA_ARTIFACT_DIR/vendor_kernel_boot.img"
cp "$ARTIFACT_DIR/super.img" "$EXTRA_ARTIFACT_DIR/super.img"
printf 'undeclared-dtbo-image\n' >"$EXTRA_ARTIFACT_DIR/dtbo.img"
EXTRA_ARTIFACT_OUT="$TMP_DIR/extra-artifact.out"
if node "$REPO_ROOT/scripts/android-installer/validate-release-manifest.ts" \
  "$ARTIFACT_MANIFEST" \
  --artifact-dir "$EXTRA_ARTIFACT_DIR" >"$EXTRA_ARTIFACT_OUT" 2>&1; then
  fail "manifest validator accepted an undeclared image that the installer would flash"
fi
assert_contains "$EXTRA_ARTIFACT_OUT" "dtbo.img: image is not declared by the release manifest"
pass "manifest validator refuses undeclared flash images"

if FAKE_LOGCAT_FAIL=1 "$REPO_ROOT/scripts/android-installer/validate-post-flash.sh" --device TEST123 --execute >"$TMP_DIR/logcat.out" 2>&1; then
  fail "validator accepted failed logcat transport"
fi
pass "validator fails closed when logcat cannot be read"

# Network-connected Cuttlefish serials contain a colon.
cat >"$BIN_DIR/adb" <<'EOF'
#!/usr/bin/env bash
case "$*" in
  "devices -l") printf 'List of devices attached\n127.0.0.1:6521 device\n' ;;
  *"settings get global adb_enabled") echo 1 ;;
  *) echo fixture ;;
esac
EOF
chmod +x "$BIN_DIR/adb"
for serial in explicit automatic; do
  selection=()
  [[ "$serial" != explicit ]] || selection=(--device 127.0.0.1:6521)
  "$ROOT/install-elizaos-android.sh" --artifact-dir "$ARTIFACT_DIR" --execute "${selection[@]}" >"$TMP_DIR/network.out" 2>&1
  assert_contains "$TMP_DIR/network.out" "adb -s 127.0.0.1:6521"
done
pass "legacy discovery preserves network ADB serials"

# Rejections must occur before any transport is invoked.
for tool in adb fastboot; do
  cat >"$BIN_DIR/$tool" <<'EOF'
#!/usr/bin/env bash
echo unexpected-transport-call >&2
exit 99
EOF
  chmod +x "$BIN_DIR/$tool"
done
for entry in "$ROOT/install-elizaos-android.sh" "$REPO_ROOT/scripts/android-installer/validate-post-flash.sh"; do
  input=()
  [[ "$entry" != "$ROOT/install-elizaos-android.sh" ]] || input=(--artifact-dir "$ARTIFACT_DIR")
  for order in first last; do
    flags=(--dry-run --execute)
    [[ "$order" != last ]] || flags=(--execute --dry-run)
    if "$entry" "${input[@]}" "${flags[@]}" >"$TMP_DIR/refusal.out" 2>&1; then fail "accepted conflicting execution flags"; fi
    assert_contains "$TMP_DIR/refusal.out" "--dry-run conflicts with --execute"
  done
  if "$entry" "${input[@]}" --device 'SERIAL --transport-id 2' --execute >"$TMP_DIR/refusal.out" 2>&1; then fail "accepted invalid serial"; fi
  assert_contains "$TMP_DIR/refusal.out" "invalid device serial"
done
pass "installer and validator reject conflicts and serial argument injection before transport"
for option in --launcher-package --expect; do
  if "$REPO_ROOT/scripts/android-installer/validate-post-flash.sh" "$option" 'x;touch /data/local/tmp/injected=value' --execute >"$TMP_DIR/refusal.out" 2>&1; then fail "accepted remote shell injection"; fi
  if grep -q unexpected-transport-call "$TMP_DIR/refusal.out"; then fail "queried device before rejecting remote shell injection"; fi
  assert_contains "$TMP_DIR/refusal.out" "invalid"
done
pass "legacy validator rejects remote shell metacharacters before transport"
"$ROOT/install-elizaos-android.sh" --artifact-dir "$ARTIFACT_DIR" >"$TMP_DIR/offline.out" 2>&1
if grep -q unexpected-transport-call "$TMP_DIR/offline.out"; then fail "dry-run queried transport"; fi
pass "legacy planning never invokes transport"
