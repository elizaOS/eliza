#!/usr/bin/env bash

eliza_default_cache_root() {
  if [[ -n "${ELIZA_CACHE_ROOT:-}" ]]; then
    printf '%s\n' "$ELIZA_CACHE_ROOT"
  elif [[ -n "${XDG_CACHE_HOME:-}" ]]; then
    printf '%s\n' "$XDG_CACHE_HOME/eliza-hub"
  elif [[ -n "${HOME:-}" ]]; then
    printf '%s\n' "$HOME/.cache/eliza-hub"
  else
    printf '%s\n' "/var/tmp/eliza-hub/cache"
  fi
}

eliza_default_artifact_root() {
  if [[ -n "${ELIZA_ARTIFACT_ROOT:-}" ]]; then
    printf '%s\n' "$ELIZA_ARTIFACT_ROOT"
  elif [[ -n "${XDG_STATE_HOME:-}" ]]; then
    printf '%s\n' "$XDG_STATE_HOME/eliza-hub/artifacts"
  elif [[ -n "${HOME:-}" ]]; then
    printf '%s\n' "$HOME/.local/state/eliza-hub/artifacts"
  else
    printf '%s\n' "/var/tmp/eliza-hub/artifacts"
  fi
}

ELIZA_CACHE_ROOT="$(eliza_default_cache_root)"
ELIZA_ARTIFACT_ROOT="$(eliza_default_artifact_root)"
ELIZA_TMP_ROOT="${ELIZA_TMP_ROOT:-$ELIZA_CACHE_ROOT/tmp}"

export ELIZA_CACHE_ROOT
export ELIZA_ARTIFACT_ROOT
export ELIZA_TMP_ROOT

eliza_artifact_path() {
  printf '%s/%s\n' "$ELIZA_ARTIFACT_ROOT" "$1"
}

eliza_tmp_path() {
  printf '%s/%s\n' "$ELIZA_TMP_ROOT" "$1"
}

eliza_prepare_artifact_dirs() {
  mkdir -p "$ELIZA_ARTIFACT_ROOT" "$ELIZA_TMP_ROOT"
}
