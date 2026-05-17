#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$TMP_DIR"
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
printf '\0' >"$ARTIFACT_DIR/boot.img"
printf '\1' >"$ARTIFACT_DIR/vendor_boot.img"
printf '\2' >"$ARTIFACT_DIR/super.img"

cat >"$BIN_DIR/adb" <<'EOF'
#!/usr/bin/env bash
case "$*" in
  *"devices -l"*) printf 'List of devices attached\nTEST123 device usb:1-1 product:test model:Test device:caiman\n' ;;
  *"get-state"*) echo device ;;
  *"getprop ro.product.device"*) echo caiman ;;
  *"getprop ro.build.fingerprint"*) echo 'elizaos/caiman/caiman:16/example:userdebug/test-keys' ;;
  *"getprop ro.boot.slot_suffix"*) echo '_a' ;;
  *"getprop sys.boot_completed"*) echo 1 ;;
  *"settings get global adb_enabled"*) echo 1 ;;
  *) echo "fake adb $*" ;;
esac
EOF

cat >"$BIN_DIR/fastboot" <<'EOF'
#!/usr/bin/env bash
case "$*" in
  *"getvar unlocked"*) echo 'unlocked: yes' >&2 ;;
  *"getvar product"*) echo 'product: caiman' >&2 ;;
  *) echo "fake fastboot $*" ;;
esac
EOF

chmod +x "$BIN_DIR/adb" "$BIN_DIR/fastboot"
export PATH="$BIN_DIR:$PATH"

INSTALL_OUT="$TMP_DIR/install.out"
"$ROOT/install-elizaos-android.sh" --artifact-dir "$ARTIFACT_DIR" >"$INSTALL_OUT"
assert_contains "$INSTALL_OUT" "Dry-run only. No commands were executed."
assert_contains "$INSTALL_OUT" "fastboot flash boot"
assert_contains "$INSTALL_OUT" "fastboot flash vendor_boot"
assert_contains "$INSTALL_OUT" "fastboot flash super"
pass "installer dry-run plans discovered images"

VALIDATE_OUT="$TMP_DIR/validate.out"
"$ROOT/scripts/validate-post-flash.sh" \
  --device TEST123 \
  --manifest "$ROOT/manifests/android-release-manifest.example.json" \
  >"$VALIDATE_OUT"
assert_contains "$VALIDATE_OUT" "Dry-run only. No ADB commands were executed."
assert_contains "$VALIDATE_OUT" "ro.product.device=caiman"
assert_contains "$VALIDATE_OUT" "ro.build.fingerprint^=elizaos/caiman/caiman:"
pass "post-flash validator dry-run reads manifest expectations"

VALIDATE_EXEC_OUT="$TMP_DIR/validate-exec.out"
"$ROOT/scripts/validate-post-flash.sh" \
  --device TEST123 \
  --manifest "$ROOT/manifests/android-release-manifest.example.json" \
  --execute \
  >"$VALIDATE_EXEC_OUT"
assert_contains "$VALIDATE_EXEC_OUT" "+ adb -s TEST123 get-state"
pass "post-flash validator execute path works with fake adb"

MANIFEST_OUT="$TMP_DIR/manifest.out"
node "$ROOT/scripts/validate-release-manifest.mjs" \
  "$ROOT/manifests/android-release-manifest.example.json" \
  >"$MANIFEST_OUT"
assert_contains "$MANIFEST_OUT" "manifest ok: elizaos-android-example-2026.05.0"
pass "manifest validator accepts example manifest"

HASH_BOOT="$(node -e "const {createHash}=require('node:crypto'); const {readFileSync}=require('node:fs'); process.stdout.write(createHash('sha256').update(readFileSync(process.argv[1])).digest('hex'))" "$ARTIFACT_DIR/boot.img")"
HASH_VENDOR_BOOT="$(node -e "const {createHash}=require('node:crypto'); const {readFileSync}=require('node:fs'); process.stdout.write(createHash('sha256').update(readFileSync(process.argv[1])).digest('hex'))" "$ARTIFACT_DIR/vendor_boot.img")"
HASH_SUPER="$(node -e "const {createHash}=require('node:crypto'); const {readFileSync}=require('node:fs'); process.stdout.write(createHash('sha256').update(readFileSync(process.argv[1])).digest('hex'))" "$ARTIFACT_DIR/super.img")"
ARTIFACT_MANIFEST="$TMP_DIR/release-manifest.json"
node - "$ROOT/manifests/android-release-manifest.example.json" "$ARTIFACT_MANIFEST" "$HASH_BOOT" "$HASH_VENDOR_BOOT" "$HASH_SUPER" <<'NODE'
const { readFileSync, writeFileSync } = require('node:fs');
const [source, target, bootHash, vendorBootHash, superHash] = process.argv.slice(2);
const manifest = JSON.parse(readFileSync(source, 'utf8'));
manifest.artifacts[0].sha256 = bootHash;
manifest.artifacts[1].sha256 = vendorBootHash;
manifest.artifacts[2].sha256 = superHash;
writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`);
NODE

ARTIFACT_VALIDATE_OUT="$TMP_DIR/artifact-validate.out"
node "$ROOT/scripts/validate-release-manifest.mjs" \
  "$ARTIFACT_MANIFEST" \
  --artifact-dir "$ARTIFACT_DIR" \
  >"$ARTIFACT_VALIDATE_OUT"
assert_contains "$ARTIFACT_VALIDATE_OUT" "artifacts ok: $ARTIFACT_DIR"
pass "manifest validator checks artifact size and hashes"
