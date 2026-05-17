#!/usr/bin/env bash
set -euo pipefail

DRY_RUN=1
EXECUTE=0
CONFIRM_FLASH=0
SKIP_PREFLIGHT=0
ASSUME_BOOTLOADER=0
WIPE_DATA=0
REBOOT_AFTER_FLASH=0
DEVICE_SERIAL=""
ARTIFACT_DIR=""
SLOT=""
declare -a IMAGE_SPECS=()
declare -a PLAN=()
declare -a VALIDATION_PLAN=()

usage() {
  cat <<'EOF'
Usage:
  install-elizaos-android.sh --artifact-dir OUT_DIR [options]
  install-elizaos-android.sh --image partition=/path/to/image.img [--image ...] [options]

Plans and optionally runs an ElizaOS Android image flash through adb/fastboot.
The default mode is dry-run: commands are printed and no device is modified.

Required image input:
  --artifact-dir DIR          Directory containing Android build artifacts. Known
                              images are discovered by filename, for example
                              boot.img, vendor_boot.img, dtbo.img, vbmeta.img,
                              super.img, product.img, system.img, vendor.img,
                              system_ext.img, and odm.img.
  --image PARTITION=PATH      Add an explicit image. May be repeated. Explicit
                              images override discovered artifact-dir images.

Device and safety options:
  --device SERIAL             adb/fastboot serial. Required if multiple devices
                              are attached.
  --slot SLOT                 Pass --slot SLOT to fastboot flash commands.
  --skip-preflight            Skip USB debugging and bootloader unlock checks.
  --assume-bootloader         Do not plan or run adb reboot bootloader.
  --wipe-data                 Add fastboot -w after flashing. Never implied.
  --reboot-after-flash        Reboot and run post-flash adb validation.

Execution options:
  --dry-run                   Print the plan only. This is the default.
  --execute                   Run non-flashing discovery/preflight commands.
  --confirm-flash             Allow fastboot flash commands to run. Must be used
                              together with --execute.

Examples:
  packages/os/android/installer/install-elizaos-android.sh \
    --artifact-dir out/target/product/caiman

  packages/os/android/installer/install-elizaos-android.sh \
    --device ABC123 --artifact-dir out/target/product/caiman \
    --execute --confirm-flash --reboot-after-flash
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
      --device)
        [[ $# -ge 2 ]] || die "--device requires a serial"
        DEVICE_SERIAL="$2"
        shift 2
        ;;
      --slot)
        [[ $# -ge 2 ]] || die "--slot requires a slot name"
        SLOT="$2"
        shift 2
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
        DRY_RUN=1
        EXECUTE=0
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

  if [[ -z "$ARTIFACT_DIR" && "${#IMAGE_SPECS[@]}" -eq 0 ]]; then
    die "provide --artifact-dir or at least one --image PARTITION=PATH"
  fi

  if [[ "$CONFIRM_FLASH" -eq 1 && "$EXECUTE" -ne 1 ]]; then
    die "--confirm-flash only has an effect with --execute"
  fi
}

discover_adb_device() {
  local devices
  devices="$(adb devices -l | awk 'NR > 1 && NF > 0 {print $1 ":" $2}')"

  if [[ -n "$DEVICE_SERIAL" ]]; then
    local state
    state="$(echo "$devices" | awk -F: -v serial="$DEVICE_SERIAL" '$1 == serial {print $2; found=1} END {if (!found) exit 1}' || true)"
    [[ -n "$state" ]] || die "adb device '$DEVICE_SERIAL' was not found"
    [[ "$state" == "device" ]] || die "adb device '$DEVICE_SERIAL' is '$state'; authorize USB debugging and reconnect"
    return
  fi

  local ready_count
  ready_count="$(echo "$devices" | awk -F: '$2 == "device" {count++} END {print count + 0}')"
  if [[ "$ready_count" -eq 0 ]]; then
    if echo "$devices" | grep -q ':unauthorized'; then
      die "adb sees an unauthorized device; accept the USB debugging prompt on the device"
    fi
    die "no adb device in 'device' state was found"
  fi
  if [[ "$ready_count" -gt 1 ]]; then
    echo "$devices" >&2
    die "multiple adb devices are attached; pass --device SERIAL"
  fi

  DEVICE_SERIAL="$(echo "$devices" | awk -F: '$2 == "device" {print $1; exit}')"
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

collect_images() {
  local specs=()
  local known_images=(
    boot
    vendor_boot
    dtbo
    vbmeta
    vbmeta_system
    init_boot
    super
    product
    system
    system_ext
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
  add_plan "${fastboot_cmd[@]}" flashing get_unlock_ability

  local spec partition image
  for spec in "${IMAGE_SPECS[@]}"; do
    partition="${spec%%=*}"
    image="${spec#*=}"
    if [[ -n "$SLOT" ]]; then
      add_plan "${fastboot_cmd[@]}" flash --slot "$SLOT" "$partition" "$image"
    else
      add_plan "${fastboot_cmd[@]}" flash "$partition" "$image"
    fi
  done

  if [[ "$WIPE_DATA" -eq 1 ]]; then
    add_plan "${fastboot_cmd[@]}" -w
  fi

  if [[ "$REBOOT_AFTER_FLASH" -eq 1 ]]; then
    add_plan "${fastboot_cmd[@]}" reboot
    add_validation_plan "${adb_cmd[@]}" wait-for-device
    add_validation_plan "${adb_cmd[@]}" shell getprop ro.product.device
    add_validation_plan "${adb_cmd[@]}" shell getprop ro.build.fingerprint
    add_validation_plan "${adb_cmd[@]}" shell getprop sys.boot_completed
  fi
}

print_plan() {
  echo
  echo "Flash command plan:"
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
    echo "Discovery/preflight may run, but flashing is blocked until --confirm-flash is provided."
  fi
}

fastboot_preflight() {
  [[ "$SKIP_PREFLIGHT" -eq 0 ]] || return

  local fastboot_cmd
  read -r -a fastboot_cmd <<<"$(fastboot_base)"

  run_cmd "${fastboot_cmd[@]}" devices

  local unlocked
  unlocked="$("${fastboot_cmd[@]}" getvar unlocked 2>&1 | awk -F': ' '/unlocked:/ {print $2; exit}' | tr -d '\r' || true)"
  if [[ "$unlocked" != "yes" && "$unlocked" != "true" ]]; then
    die "bootloader does not report unlocked=yes; unlock it manually before flashing"
  fi
}

execute_plan() {
  if [[ "$EXECUTE" -ne 1 ]]; then
    return
  fi

  if [[ "$CONFIRM_FLASH" -ne 1 ]]; then
    log "execution requested without --confirm-flash; stopping before bootloader/flashing commands"
    return
  fi

  if [[ "$ASSUME_BOOTLOADER" -eq 1 ]]; then
    fastboot_preflight
  fi

  local command
  for command in "${PLAN[@]}"; do
    eval "run_cmd $command"
    if [[ "$command" == *" reboot bootloader" ]]; then
      sleep 3
      fastboot_preflight
    fi
  done

  if [[ "${#VALIDATION_PLAN[@]}" -gt 0 ]]; then
    for command in "${VALIDATION_PLAN[@]}"; do
      eval "run_cmd $command"
    done
  fi
}

main() {
  parse_args "$@"
  require_tool adb
  require_tool fastboot
  collect_images

  if [[ "$DRY_RUN" -eq 0 && "$ASSUME_BOOTLOADER" -eq 0 ]]; then
    preflight_adb
  fi

  build_plan
  print_plan
  execute_plan
}

main "$@"
