#!/usr/bin/env bash
set -euo pipefail

DRY_RUN=1
EXECUTE=0
EXPLICIT_DRY_RUN=0
CONFIRM_FLASH=0
SKIP_PREFLIGHT=0
ASSUME_BOOTLOADER=0
WIPE_DATA=0
REBOOT_AFTER_FLASH=0
DEVICE_SERIAL=""
ARTIFACT_DIR=""
MANIFEST=""
SLOT=""
ANDROID_INFO=""
ALLOW_STALE_ARTIFACTS=0
# Loose images selected by filename can silently mix build generations; a
# coherent image set is written within one packaging pass. One hour absorbs a
# long target-files packaging step while still catching day-old strays.
MAX_ARTIFACT_MTIME_SPREAD_SECONDS=3600
FLASH_SUPPORTED_CODENAMES=""
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VALIDATOR_DIR="$ROOT/../../scripts/android-installer"
# Packaged installers carry their validators alongside the entry point.
if [[ ! -d "$VALIDATOR_DIR" ]]; then
  VALIDATOR_DIR="$ROOT/scripts"
fi
POST_FLASH_VALIDATOR="$VALIDATOR_DIR/validate-post-flash.sh"
RELEASE_MANIFEST_VALIDATOR="$VALIDATOR_DIR/validate-release-manifest.mjs"
declare -a IMAGE_SPECS=()
declare -a PLAN=()
declare -a VALIDATION_PLAN=()
declare -a MANIFEST_PARTITIONS=()
declare -a MANIFEST_MODES=()

usage() {
  cat <<'EOF'
Usage:
  install-elizaos-android.sh --artifact-dir OUT_DIR [options]
  install-elizaos-android.sh --image partition=/path/to/image.img [--image ...] [options]

Plans legacy images or delegates signed v2 installation to the shared executor.
The default mode is dry-run: commands are printed and no device is modified.

Required image input:
  --artifact-dir DIR          Directory containing Android build artifacts. Known
                              images are discovered by filename, for example
                              boot.img, vendor_boot.img, dtbo.img, vbmeta.img,
                              super.img, product.img, system.img, vendor.img,
                              system_ext.img, and odm.img.
  --image PARTITION=PATH      Add an explicit image. May be repeated. Explicit
                              images override discovered artifact-dir images.
  --manifest FILE             Signed v2 release contract required for flashing.
  --tool-dir DIR              Digest-pinned adb/fastboot (Linux execution).
  --recovery-dir DIR          Retained qualified recovery archive.
  --health-token-file FILE   Private local agent bearer for post-boot checks.
  --journal FILE              New private JSONL file for durable command results.

Device and safety options:
  --device SERIAL             adb/fastboot serial. Always required for confirmed
                              installation; discovery can select one device.
  --slot SLOT                 Pass --slot SLOT to fastboot flash commands and
                              set it active after flashing, so a bootloader
                              slot-fallback cannot silently boot the other
                              (stock) slot and confound the experiment.
  --android-info FILE         Enforce the build's android-info.txt requirements
                              (board, version-bootloader, version-baseband,
                              partition-exists) against fastboot getvar before
                              flashing.
  --allow-stale-artifacts     Skip the artifact-coherence check that refuses an
                              artifact dir whose image mtimes span more than an
                              hour (a signature of mixed build generations).
  --skip-preflight            Skip legacy discovery checks only; forbidden for flashing.
  --assume-bootloader         Do not plan or run adb reboot bootloader.
  --wipe-data                 Authorize qualified data wipes. Never implied.
                              Required the first time the userdata/encryption
                              contract changes (fstab stance, verity state).
  --reboot-after-flash        Reboot and run post-flash adb validation.

Execution options:
  --dry-run                   Print the plan only. This is the default.
  --execute                   Run non-flashing discovery/preflight commands.
  --confirm-flash             Allow fastboot flash commands to run. Must be used
                              together with --execute.

Examples:
  android/installer/install-elizaos-android.sh \
    --artifact-dir out/target/product/tegu

  android/installer/install-elizaos-android.sh \
    --device ABC123 --artifact-dir /absolute/bundle/flash \
    --manifest /absolute/release.android-release.json \
    --tool-dir /absolute/platform-tools --recovery-dir /absolute/recovery \
    --journal /absolute/private/install.jsonl \
    --health-token-file /absolute/private/local-agent-token --execute --confirm-flash --reboot-after-flash
EOF
}

die() {
  echo "error: $*" >&2
  exit 1
}

log() {
  echo "==> $*"
}

shell_join() {
  local out=""
  local arg
  for arg in "$@"; do
    if [[ -z "$out" ]]; then
      printf -v out "%q" "$arg"
    else
      printf -v out "%s %q" "$out" "$arg"
    fi
  done
  echo "$out"
}

add_plan() {
  PLAN+=("$(shell_join "$@")")
}

add_validation_plan() {
  VALIDATION_PLAN+=("$(shell_join "$@")")
}

run_cmd() {
  local printable
  printable="$(shell_join "$@")"
  echo "+ $printable"
  if [[ "$DRY_RUN" -eq 0 ]]; then
    "$@"
  fi
}

require_tool() {
  command -v "$1" >/dev/null 2>&1 || die "required tool '$1' was not found in PATH"
}

adb_base() {
  if [[ -n "$DEVICE_SERIAL" ]]; then
    echo adb -s "$DEVICE_SERIAL"
  else
    echo adb
  fi
}

fastboot_base() {
  if [[ -n "$DEVICE_SERIAL" ]]; then
    echo fastboot -s "$DEVICE_SERIAL"
  else
    echo fastboot
  fi
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --artifact-dir)
        [[ $# -ge 2 ]] || die "--artifact-dir requires a directory"
        ARTIFACT_DIR="$2"
        shift 2
        ;;
      --image)
        [[ $# -ge 2 ]] || die "--image requires PARTITION=PATH"
        IMAGE_SPECS+=("$2")
        shift 2
        ;;
      --journal|--tool-dir|--recovery-dir|--health-token-file)
        [[ $# -ge 2 ]] || die "$1 requires a value"
        shift 2
        ;;
      --device)
        [[ $# -ge 2 ]] || die "--device requires a serial"
        DEVICE_SERIAL="$2"
        shift 2
        ;;
      --manifest)
        [[ $# -ge 2 ]] || die "--manifest requires a file"
        MANIFEST="$2"
        shift 2
        ;;
      --slot)
        [[ $# -ge 2 ]] || die "--slot requires a slot name"
        SLOT="$2"
        [[ "$SLOT" =~ ^[ab]$ ]] || die "--slot must be 'a' or 'b'"
        shift 2
        ;;
      --android-info)
        [[ $# -ge 2 ]] || die "--android-info requires a file"
        ANDROID_INFO="$2"
        shift 2
        ;;
      --allow-stale-artifacts)
        ALLOW_STALE_ARTIFACTS=1
        shift
        ;;
      --skip-preflight)
        SKIP_PREFLIGHT=1
        shift
        ;;
      --assume-bootloader)
        ASSUME_BOOTLOADER=1
        shift
        ;;
      --wipe-data)
        WIPE_DATA=1
        shift
        ;;
      --reboot-after-flash)
        REBOOT_AFTER_FLASH=1
        shift
        ;;
      --dry-run)
        EXPLICIT_DRY_RUN=1
        DRY_RUN=1
        shift
        ;;
      --execute)
        DRY_RUN=0
        EXECUTE=1
        shift
        ;;
      --confirm-flash)
        CONFIRM_FLASH=1
        shift
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        die "unknown argument: $1"
        ;;
    esac
  done

  [[ "$EXPLICIT_DRY_RUN" -eq 0 || "$EXECUTE" -eq 0 ]] || die "--dry-run conflicts with --execute"
  [[ -z "$DEVICE_SERIAL" || "$DEVICE_SERIAL" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]*$ ]] || die "invalid device serial"

  if [[ -z "$ARTIFACT_DIR" && "${#IMAGE_SPECS[@]}" -eq 0 ]]; then
    die "provide --artifact-dir or at least one --image PARTITION=PATH"
  fi

  if [[ -n "$ANDROID_INFO" && ! -f "$ANDROID_INFO" ]]; then
    die "--android-info file does not exist: $ANDROID_INFO"
  fi

  if [[ "$CONFIRM_FLASH" -eq 1 && "$EXECUTE" -ne 1 ]]; then
    die "--confirm-flash only has an effect with --execute"
  fi
  if [[ "$CONFIRM_FLASH" -eq 1 ]]; then
    [[ -n "$MANIFEST" ]] || die "--confirm-flash requires --manifest"
    [[ -n "$ARTIFACT_DIR" ]] || die "--confirm-flash requires --artifact-dir"
    [[ "${#IMAGE_SPECS[@]}" -eq 0 ]] || die "--confirm-flash refuses explicit --image overrides"
    [[ "$SKIP_PREFLIGHT" -eq 0 ]] || die "--confirm-flash refuses --skip-preflight"
  fi
  if [[ "$REBOOT_AFTER_FLASH" -eq 1 && -z "$MANIFEST" ]]; then
    die "--reboot-after-flash requires --manifest for post-flash validation"
  fi
}

validate_release_inputs() {
  if [[ -n "$MANIFEST" ]]; then
    [[ -f "$MANIFEST" ]] || die "release manifest does not exist: $MANIFEST"
    require_tool node
  fi

  # Keep a supplied manifest's partition-mode contract available to the flash-plan
  # builder. Logical/dynamic partitions must be flashed from fastbootd; the
  # bootloader cannot safely substitute for that mode. Use indexed arrays
  # instead of associative arrays because the installer also supports the
  # system Bash 3.2 shipped by macOS.
  if [[ -n "$MANIFEST" ]]; then
    local manifest_modes
    manifest_modes="$(node -e '
      const fs = require("node:fs");
      const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      for (const artifact of manifest.artifacts || []) {
        process.stdout.write(`${artifact.partition}\t${artifact.fastbootMode}\n`);
      }
    ' "$MANIFEST" 2>/dev/null)" || die "could not read release manifest: $MANIFEST"
    while IFS=$'\t' read -r partition mode; do
      [[ -n "$partition" && -n "$mode" ]] || continue
      MANIFEST_PARTITIONS+=("$partition")
      MANIFEST_MODES+=("$mode")
    done <<< "$manifest_modes"
  fi

  [[ "$CONFIRM_FLASH" -eq 1 ]] || return 0
  node "$RELEASE_MANIFEST_VALIDATOR" "$MANIFEST" --artifact-dir "$ARTIFACT_DIR"
  FLASH_SUPPORTED_CODENAMES="$(node -e '
    const fs = require("node:fs");
    const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const devices = (manifest.supportedDevices || [])
      .filter((device) => device && device.tier === "lab-validated")
      .map((device) => String(device.codename || ""))
      .filter((codename) => /^[a-z0-9_]+$/.test(codename));
    if (devices.length === 0) process.exit(2);
    process.stdout.write(devices.join(" "));
  ' "$MANIFEST")" || die "release manifest has no lab-validated device codename"
}

flash_mode_for_partition() {
  local partition="$1"
  local index
  for index in "${!MANIFEST_PARTITIONS[@]}"; do
    if [[ "${MANIFEST_PARTITIONS[$index]}" == "$partition" ]]; then
      echo "${MANIFEST_MODES[$index]}"
      return 0
    fi
  done
  # Unmanifested dry-runs predate the release-mode contract. Preserve their
  # useful planning behavior, while confirmed flashes always have a manifest.
  echo bootloader
}

discover_adb_device() {
  local devices
  devices="$(adb devices -l | awk 'NR > 1 && NF > 0 {print $1 "\t" $2}')"

  if [[ -n "$DEVICE_SERIAL" ]]; then
    local state
    state="$(echo "$devices" | awk -F '\t' -v serial="$DEVICE_SERIAL" '$1 == serial {print $2; found=1} END {if (!found) exit 1}' || true)"
    [[ -n "$state" ]] || die "adb device '$DEVICE_SERIAL' was not found"
    [[ "$state" == "device" ]] || die "adb device '$DEVICE_SERIAL' is '$state'; authorize USB debugging and reconnect"
    return
  fi

  local ready_count
  ready_count="$(echo "$devices" | awk -F '\t' '$2 == "device" {count++} END {print count + 0}')"
  if [[ "$ready_count" -eq 0 ]]; then
    if echo "$devices" | grep -q $'\tunauthorized'; then
      die "adb sees an unauthorized device; accept the USB debugging prompt on the device"
    fi
    die "no adb device in 'device' state was found"
  fi
  if [[ "$ready_count" -gt 1 ]]; then
    echo "$devices" >&2
    die "multiple adb devices are attached; pass --device SERIAL"
  fi

  DEVICE_SERIAL="$(echo "$devices" | awk -F '\t' '$2 == "device" {print $1; exit}')"
  [[ "$DEVICE_SERIAL" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]*$ ]] || die "invalid discovered device serial"
  log "selected adb device $DEVICE_SERIAL"
}

preflight_adb() {
  [[ "$SKIP_PREFLIGHT" -eq 0 ]] || return

  discover_adb_device

  local adb_cmd
  read -r -a adb_cmd <<<"$(adb_base)"
  run_cmd "${adb_cmd[@]}" get-state
  run_cmd "${adb_cmd[@]}" shell getprop ro.product.device
  run_cmd "${adb_cmd[@]}" shell getprop ro.build.fingerprint

  local debug_state
  debug_state="$("${adb_cmd[@]}" shell settings get global adb_enabled 2>/dev/null | tr -d '\r' || true)"
  [[ "$debug_state" == "1" ]] || die "USB debugging is not enabled according to adb_enabled=$debug_state"
}

file_mtime() {
  # GNU stat accepts BSD's -f flag as a filesystem-format query and exits 0,
  # so checking it first yields labels rather than an epoch on Linux. Prefer
  # the numeric GNU form and use BSD stat only when that probe is unavailable.
  local mtime=""
  mtime="$(stat -c %Y "$1" 2>/dev/null || true)"
  if [[ "$mtime" =~ ^[0-9]+$ ]]; then
    echo "$mtime"
    return 0
  fi
  stat -f %m "$1" 2>/dev/null
}

# Images discovered by filename accumulate across builds in a shared out/
# directory; a vbmeta from build N over a boot.img from build N-1 fails
# verified boot with no diagnosis. A coherent set is written within a single
# packaging pass, so an mtime spread wider than the threshold means the
# directory is mixing build generations.
assert_artifact_coherence() {
  [[ "$ALLOW_STALE_ARTIFACTS" -eq 0 ]] || return 0
  [[ $# -ge 2 ]] || return 0
  local spec image mtime min_mtime="" max_mtime="" min_image="" max_image=""
  for spec in "$@"; do
    image="${spec#*=}"
    mtime="$(file_mtime "$image")" || die "could not read mtime of $image"
    if [[ -z "$min_mtime" || "$mtime" -lt "$min_mtime" ]]; then
      min_mtime="$mtime"
      min_image="$image"
    fi
    if [[ -z "$max_mtime" || "$mtime" -gt "$max_mtime" ]]; then
      max_mtime="$mtime"
      max_image="$image"
    fi
  done
  local spread=$((max_mtime - min_mtime))
  if [[ "$spread" -gt "$MAX_ARTIFACT_MTIME_SPREAD_SECONDS" ]]; then
    die "artifact dir mixes build generations: $min_image and $max_image were written ${spread}s apart (max ${MAX_ARTIFACT_MTIME_SPREAD_SECONDS}s). Extract one coherent image set into a fresh directory, or pass --allow-stale-artifacts to override."
  fi
}

collect_images() {
  local specs=()
  local known_images=(
    boot
    vendor_boot
    vendor_kernel_boot
    dtbo
    pvmfw
    vbmeta
    vbmeta_system
    vbmeta_vendor
    init_boot
    super
    product
    system
    system_ext
    system_dlkm
    vendor
    vendor_dlkm
    odm
    odm_dlkm
  )

  if [[ -n "$ARTIFACT_DIR" ]]; then
    [[ -d "$ARTIFACT_DIR" ]] || die "artifact directory does not exist: $ARTIFACT_DIR"
    local partition
    for partition in "${known_images[@]}"; do
      if [[ -f "$ARTIFACT_DIR/$partition.img" ]]; then
        specs+=("$partition=$ARTIFACT_DIR/$partition.img")
      fi
    done
  fi

  if [[ "${#IMAGE_SPECS[@]}" -gt 0 ]]; then
    specs+=("${IMAGE_SPECS[@]}")
  fi
  [[ "${#specs[@]}" -gt 0 ]] || die "no image artifacts were found"

  local seen_partitions=" "
  local spec partition image
  IMAGE_SPECS=()
  for spec in "${specs[@]}"; do
    [[ "$spec" == *=* ]] || die "--image must be PARTITION=PATH, got '$spec'"
    partition="${spec%%=*}"
    [[ "$partition" =~ ^[A-Za-z0-9][A-Za-z0-9_-]*$ ]] || die "invalid partition name"
    image="${spec#*=}"
    [[ -n "$partition" && -n "$image" ]] || die "invalid image spec '$spec'"
    [[ -f "$image" ]] || die "image for partition '$partition' does not exist: $image"

    if [[ "$seen_partitions" == *" $partition "* ]]; then
      local index
      for index in "${!IMAGE_SPECS[@]}"; do
        if [[ "${IMAGE_SPECS[$index]%%=*}" == "$partition" ]]; then
          IMAGE_SPECS[index]="$partition=$image"
        fi
      done
    else
      IMAGE_SPECS+=("$partition=$image")
      seen_partitions+="$partition "
    fi
  done
  # Apply the coherence check to the final deduplicated set so an explicit
  # --image override is honored instead of being rejected because the
  # superseded artifact-dir file is stale.
  if [[ -n "$ARTIFACT_DIR" ]]; then
    assert_artifact_coherence "${IMAGE_SPECS[@]}"
  fi
}

build_plan() {
  local adb_cmd fastboot_cmd
  read -r -a adb_cmd <<<"$(adb_base)"
  read -r -a fastboot_cmd <<<"$(fastboot_base)"

  if [[ "$ASSUME_BOOTLOADER" -eq 0 ]]; then
    add_plan "${adb_cmd[@]}" reboot bootloader
  fi

  add_plan "${fastboot_cmd[@]}" devices
  add_plan "${fastboot_cmd[@]}" getvar product
  add_plan "${fastboot_cmd[@]}" getvar unlocked
  add_plan "${fastboot_cmd[@]}" getvar current-slot
  add_plan "${fastboot_cmd[@]}" flashing get_unlock_ability

  local spec partition image mode current_mode="bootloader"
  for spec in "${IMAGE_SPECS[@]}"; do
    partition="${spec%%=*}"
    [[ "$partition" =~ ^[A-Za-z0-9][A-Za-z0-9_-]*$ ]] || die "invalid partition name"
    image="${spec#*=}"
    if [[ -n "$MANIFEST" ]]; then
      local declared=0 index
      for index in "${!MANIFEST_PARTITIONS[@]}"; do
        [[ "${MANIFEST_PARTITIONS[$index]}" != "$partition" ]] || declared=1
      done
      [[ "$declared" -eq 1 ]] || die "image for partition '$partition' is not declared by the release manifest"
    fi
    mode="$(flash_mode_for_partition "$partition")"
    if [[ "$mode" != "bootloader" && "$mode" != "fastbootd" ]]; then
      die "manifest artifact '$partition' has unsupported fastboot mode '$mode'"
    fi
    if [[ "$mode" != "$current_mode" ]]; then
      if [[ "$mode" == "fastbootd" ]]; then
        add_plan "${fastboot_cmd[@]}" reboot fastboot
      else
        add_plan "${fastboot_cmd[@]}" reboot bootloader
      fi
      current_mode="$mode"
    fi
    if [[ -n "$SLOT" ]]; then
      add_plan "${fastboot_cmd[@]}" flash --slot "$SLOT" "$partition" "$image"
    else
      add_plan "${fastboot_cmd[@]}" flash "$partition" "$image"
    fi
  done

  if [[ -n "$SLOT" ]]; then
    # Pin the flashed slot as active: after repeated boot failures the
    # bootloader falls back to the other slot (still stock), which makes the
    # observed symptom unattributable to the flashed image.
    add_plan "${fastboot_cmd[@]}" --set-active="$SLOT"
  fi

  if [[ "$WIPE_DATA" -eq 1 ]]; then
    add_plan "${fastboot_cmd[@]}" -w
  fi

  if [[ "$REBOOT_AFTER_FLASH" -eq 1 ]]; then
    add_plan "${fastboot_cmd[@]}" reboot
    if [[ -n "$DEVICE_SERIAL" ]]; then
      add_validation_plan "$POST_FLASH_VALIDATOR" --device "$DEVICE_SERIAL" --manifest "$MANIFEST" --execute
    else
      add_validation_plan "$POST_FLASH_VALIDATOR" --manifest "$MANIFEST" --execute
    fi
  fi
}

print_plan() {
  echo
  echo "Legacy hypothetical flash plan (not installation authorization):"
  local command
  for command in "${PLAN[@]}"; do
    echo "  $command"
  done

  if [[ "${#VALIDATION_PLAN[@]}" -gt 0 ]]; then
    echo
    echo "Post-flash validation plan:"
    for command in "${VALIDATION_PLAN[@]}"; do
      echo "  $command"
    done
  fi

  echo
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "Dry-run only. No commands were executed."
  elif [[ "$CONFIRM_FLASH" -ne 1 ]]; then
    echo "Read-only discovery only. Actual installation requires a qualified signed v2 contract."
  fi
}

fastboot_preflight() {
  [[ "$SKIP_PREFLIGHT" -eq 0 ]] || return

  local fastboot_cmd
  read -r -a fastboot_cmd <<<"$(fastboot_base)"

  run_cmd "${fastboot_cmd[@]}" devices

  local inventory serial state found=0 count=0 selected=""
  inventory="$("${fastboot_cmd[@]}" devices)" || die "could not inventory fastboot devices"
  while read -r serial state; do
    [[ "$state" == "fastboot" ]] || continue
    count=$((count + 1))
    selected="$serial"
    [[ "$serial" != "$DEVICE_SERIAL" ]] || found=1
  done <<< "$inventory"
  if [[ -n "$DEVICE_SERIAL" ]]; then
    [[ "$found" -eq 1 ]] || die "requested device is not in normal fastboot mode: $DEVICE_SERIAL"
  else
    [[ "$count" -eq 1 ]] || die "expected exactly one normal fastboot device; found $count; pass --device SERIAL"
    [[ "$selected" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]*$ ]] || die "invalid discovered device serial"
    DEVICE_SERIAL="$selected"
    read -r -a fastboot_cmd <<<"$(fastboot_base)"
  fi

  local unlocked
  unlocked="$(fastboot_getvar_value unlocked)"
  if [[ "$unlocked" != "yes" && "$unlocked" != "true" ]]; then
    die "bootloader does not report unlocked=yes; unlock it manually before flashing"
  fi

  if [[ -n "$FLASH_SUPPORTED_CODENAMES" ]]; then
    local product
    product="$(fastboot_getvar_value product)"
    case " $FLASH_SUPPORTED_CODENAMES " in
      *" $product "*) ;;
      *) die "fastboot product '$product' is not lab-validated by $MANIFEST" ;;
    esac
  fi

  enforce_android_info
}

fastboot_getvar_value() {
  local fastboot_cmd
  read -r -a fastboot_cmd <<<"$(fastboot_base)"
  local output
  output="$("${fastboot_cmd[@]}" getvar "$1" 2>&1)" || return 1
  printf '%s\n' "$output" | awk -v key="$1" '{sub(/\r$/, ""); sub(/^\(bootloader\) */, ""); if (index($0, key ":") == 1) {value=substr($0, length(key)+2); sub(/^ */, "", value); print value; exit}}'
}

# Vendor blobs are built against the bootloader/baseband recorded in the
# build's android-info.txt; flashing them onto a different firmware set is an
# undetected contract violation. Each `require` line's value list is
# |-separated alternatives, matching fastboot's own android-info handling.
enforce_android_info() {
  [[ -n "$ANDROID_INFO" ]] || return 0
  local line key values value actual matched
  while IFS= read -r line; do
    line="${line%$'\r'}"
    case "$line" in
      require\ *=*) ;;
      *) continue ;;
    esac
    key="${line#require }"
    values="${key#*=}"
    key="${key%%=*}"
    case "$key" in
      board) actual="$(fastboot_getvar_value product)" ;;
      version-bootloader) actual="$(fastboot_getvar_value version-bootloader)" ;;
      version-baseband) actual="$(fastboot_getvar_value version-baseband)" ;;
      partition-exists)
        actual="$(fastboot_getvar_value "partition-size:$values")"
        [[ -n "$actual" ]] || die "device is missing required partition '$values' (android-info.txt)"
        continue
        ;;
      *) continue ;;
    esac
    matched=0
    local IFS='|'
    for value in $values; do
      if [[ "$actual" == "$value" ]]; then
        matched=1
        break
      fi
    done
    unset IFS
    [[ "$matched" -eq 1 ]] || die "device reports $key='$actual' but $ANDROID_INFO requires '$values'; stop and qualify the exact firmware/image combination"
  done < "$ANDROID_INFO"
}

execute_plan() {
  [[ "$EXECUTE" -eq 1 ]] || return 0
  [[ "$CONFIRM_FLASH" -ne 1 ]] || die "confirmed flashing must use the signed v2 installer"
  log "execution requested without --confirm-flash; stopping before bootloader/flashing commands"
}

main() {
  local original_args=("$@")
  parse_args "$@"
  # The legacy path below is discovery/planning only. All writes use the shared
  # authenticated contract and checked state machine; there is no legacy bypass.
  local signed_contract=0
  if [[ -n "$MANIFEST" && -f "$MANIFEST" ]]; then
    require_tool node
    signed_contract="$(node -e 'const m=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(m.schemaVersion===2?"1":"0")' "$MANIFEST")"
  fi
  if [[ "$CONFIRM_FLASH" -eq 1 || "$signed_contract" -eq 1 ]]; then
    require_tool node
    exec node "$ROOT/../../scripts/android/install-release.mjs" "${original_args[@]}"
  fi
  if [[ "$EXECUTE" -eq 1 ]]; then
    if [[ "$ASSUME_BOOTLOADER" -eq 1 ]]; then require_tool fastboot; else require_tool adb; fi
  fi
  collect_images
  validate_release_inputs

  if [[ "$DRY_RUN" -eq 0 && "$ASSUME_BOOTLOADER" -eq 0 ]]; then
    preflight_adb
  fi

  # Pin the serial before building any executable commands.
  if [[ "$EXECUTE" -eq 1 && "$ASSUME_BOOTLOADER" -eq 1 ]]; then
    fastboot_preflight
  fi

  build_plan
  print_plan
  execute_plan
}

main "$@"
