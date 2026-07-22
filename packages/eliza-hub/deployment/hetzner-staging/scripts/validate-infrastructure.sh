#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
INFRA_DIR="${INFRA_DIR:-$DEPLOY_DIR/terraform}"
TF_DATA_DIR="${TF_DATA_DIR:-$HOME/.cache/eliza-hub/terraform-data}"

log() {
  printf '[infrastructure-check] %s\n' "$*"
}

find_terraform() {
  if [[ -n "${TERRAFORM_BIN:-}" ]]; then
    command -v "$TERRAFORM_BIN"
    return
  fi

  if command -v tofu >/dev/null 2>&1; then
    command -v tofu
    return
  fi

  command -v terraform
}

main() {
  local terraform_bin
  terraform_bin="$(find_terraform)" || {
    printf '[infrastructure-check] error: OpenTofu or Terraform is required\n' >&2
    exit 1
  }

  [[ -d "$INFRA_DIR" ]] || {
    printf '[infrastructure-check] error: missing INFRA_DIR=%s\n' "$INFRA_DIR" >&2
    exit 1
  }

  mkdir -p "$TF_DATA_DIR"
  export TF_DATA_DIR
  export TF_IN_AUTOMATION=1

  log "using $(basename "$terraform_bin")"
  log "checking formatting"
  "$terraform_bin" fmt -check -recursive "$INFRA_DIR"

  log "initializing providers with remote backend disabled"
  "$terraform_bin" -chdir="$INFRA_DIR" init \
    -backend=false \
    -input=false \
    -lockfile=readonly \
    -no-color

  log "validating infrastructure configuration"
  "$terraform_bin" -chdir="$INFRA_DIR" validate -no-color
  log "infrastructure validation passed"
}

main "$@"
