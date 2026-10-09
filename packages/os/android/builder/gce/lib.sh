# shellcheck shell=bash
# Shared helpers for the GCE scripts in this directory. Sourced, not executed.
#
# Every cloud command goes through `run`. In the default dry-run mode `run`
# only prints the command; it executes only when the caller passed --apply.

APPLY=0

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

note() {
  printf '# %s\n' "$*"
}

# Print a command in a copy-pasteable form; quote only arguments that need it.
print_cmd() {
  local out="" arg
  for arg in "$@"; do
    if [[ "$arg" =~ ^[A-Za-z0-9_./:=,@%+-]+$ ]]; then
      out+="$arg "
    else
      out+="$(printf '%q' "$arg") "
    fi
  done
  printf '%s\n' "${out% }"
}

run() {
  print_cmd "$@"
  if [[ "$APPLY" == 1 ]]; then
    "$@"
  fi
}

# Fail closed before any real cloud call.
require_apply_prereqs() {
  [[ "$APPLY" == 1 ]] || return 0
  if [[ -z "${PROJECT:-}" ]]; then
    die "PROJECT must be set explicitly when using --apply"
  fi
  command -v gcloud >/dev/null 2>&1 || die "gcloud not found on PATH"
}

# Validate a GCE resource name (RFC 1035, max 63 chars).
check_name() {
  local value="$1" what="$2"
  [[ "$value" =~ ^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$ ]] ||
    die "$what '$value' is not a valid GCE resource name"
}

check_uint() {
  local value="$1" what="$2"
  [[ "$value" =~ ^[0-9]+$ ]] || die "$what must be a non-negative integer, got '$value'"
}

# Append EXTRA_LABELS (comma-separated GCE key=value labels) to LABELS so a
# downstream product can tag its resources without editing these scripts.
add_extra_labels() {
  local extra="${EXTRA_LABELS:-}"
  [[ -n "$extra" ]] || return 0
  [[ "$extra" =~ ^[a-z][a-z0-9_-]{0,62}=[a-z0-9_-]{0,63}(,[a-z][a-z0-9_-]{0,62}=[a-z0-9_-]{0,63})*$ ]] ||
    die "EXTRA_LABELS must be comma-separated lowercase GCE key=value labels"
  LABELS+=",$extra"
}
