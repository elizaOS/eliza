#!/usr/bin/env bash
# test_dispatch_dryrun.sh -- exercises every dispatch-*.sh in --dry-run mode,
# asserting the printed plan contains plausible commands without provisioning
# anything or requiring an API key.
#
# Exits 0 on success. On any failed assertion, prints the failing case and the
# captured output, then exits 1.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PASSED=0
FAILED=0
FAILURES=()

note() { echo "[test_dispatch_dryrun] $*"; }

# $1 = label, $2 = exit code expected, $3..N = command
run_case() {
  local label="$1" expect="$2"; shift 2
  local out rc
  out="$("$@" 2>&1)"; rc=$?
  if [[ "$rc" == "$expect" ]]; then
    PASSED=$((PASSED+1))
    note "PASS  ($label) rc=$rc"
  else
    FAILED=$((FAILED+1))
    FAILURES+=("$label (expected rc=$expect got rc=$rc)")
    note "FAIL  ($label) rc=$rc (expected $expect)"
    echo "----- output -----"
    echo "$out"
    echo "------------------"
  fi
  printf '%s\n' "$out"
}

assert_contains() {
  local label="$1" needle="$2" haystack="$3"
  if printf '%s' "$haystack" | grep -qF -- "$needle"; then
    PASSED=$((PASSED+1))
    note "PASS  ($label) found '$needle'"
  else
    FAILED=$((FAILED+1))
    FAILURES+=("$label (missing '$needle')")
    note "FAIL  ($label) missing '$needle'"
  fi
}

# --- dispatch-vast.sh, train task, multiple tiers ------------------------------
for TIER in 0_8b 2b 4b 9b 27b; do
  out="$(bash "$HERE/dispatch-vast.sh" --task train --tier "$TIER" --dry-run 2>&1 || true)"
  assert_contains "vast/train/$TIER plan-banner"  "[dispatch-vast] === PLAN ==="  "$out"
  assert_contains "vast/train/$TIER tier-line"    "tier: $TIER"                   "$out"
  assert_contains "vast/train/$TIER provider"     "provider   : vast.ai"          "$out"
  assert_contains "vast/train/$TIER dry-run-note" "DRY-RUN"                       "$out"
  assert_contains "vast/train/$TIER train_vast"   "train_vast.sh"                 "$out"
done

# --- dispatch-vast.sh, kernel-verify task --------------------------------------
out="$(bash "$HERE/dispatch-vast.sh" --task kernel-verify --gpu h100 --dry-run 2>&1 || true)"
assert_contains "vast/kernel-verify plan-banner" "[dispatch-vast] === PLAN ===" "$out"
assert_contains "vast/kernel-verify task-line"   "task         : kernel-verify"  "$out"
assert_contains "vast/kernel-verify vastai-cmd"  "vastai search offers"          "$out"
assert_contains "vast/kernel-verify create-cmd"  "vastai create instance"        "$out"
assert_contains "vast/kernel-verify destroy-cmd" "vastai destroy instance"       "$out"

# --- dispatch-vast.sh, bench task ----------------------------------------------
out="$(bash "$HERE/dispatch-vast.sh" --task bench --gpu rtx4090 --tier 0_8b --dry-run 2>&1 || true)"
assert_contains "vast/bench plan-banner"     "[dispatch-vast] === PLAN ===" "$out"
assert_contains "vast/bench tier-line"       "tier: 0_8b"                    "$out"
assert_contains "vast/bench gpu-line"        "gpu          : rtx4090"        "$out"

# --- dispatch-vast.sh, min-VRAM gate -- 9b on rtx4090 24GB must FAIL -----------
out="$(bash "$HERE/dispatch-vast.sh" --task train --tier 9b --gpu rtx4090 --dry-run 2>&1)"; rc=$?
if [[ "$rc" != "0" ]]; then
  PASSED=$((PASSED+1)); note "PASS  (vast/9b on rtx4090 vram-gate) refused as expected"
else
  FAILED=$((FAILED+1)); FAILURES+=("vast/9b on rtx4090 should have refused")
  note "FAIL  (vast/9b on rtx4090) accepted -- output:"; echo "$out"
fi

# --- dispatch-vast.sh, missing --yes-i-will-pay (without --dry-run) must FAIL --
out="$(bash "$HERE/dispatch-vast.sh" --task train --tier 9b 2>&1)"; rc=$?
if [[ "$rc" != "0" ]]; then
  PASSED=$((PASSED+1)); note "PASS  (vast/9b without --yes-i-will-pay) refused as expected"
  assert_contains "vast/no-pay refusal-message" "yes-i-will-pay" "$out"
else
  FAILED=$((FAILED+1)); FAILURES+=("vast/9b without --yes-i-will-pay should have refused")
  note "FAIL  (vast/9b no-pay) accepted -- output:"; echo "$out"
fi

# --- dispatch-nebius.sh, train task, multiple tiers ----------------------------
for TIER in 0_8b 2b 4b 9b 27b; do
  out="$(bash "$HERE/dispatch-nebius.sh" --task train --tier "$TIER" --dry-run 2>&1 || true)"
  assert_contains "nebius/train/$TIER plan-banner"  "[dispatch-nebius] === PLAN ===" "$out"
  assert_contains "nebius/train/$TIER tier-line"    "tier: $TIER"                    "$out"
  assert_contains "nebius/train/$TIER provider"     "provider   : nebius"            "$out"
  assert_contains "nebius/train/$TIER preset-line"  "preset     : gpu-h200x"         "$out"
  assert_contains "nebius/train/$TIER train_nebius" "train_nebius.sh"                "$out"
  assert_contains "nebius/train/$TIER dry-run-note" "DRY-RUN"                        "$out"
done

# --- dispatch-nebius.sh, kernel-verify task ------------------------------------
out="$(bash "$HERE/dispatch-nebius.sh" --task kernel-verify --gpu h200 --dry-run 2>&1 || true)"
assert_contains "nebius/kernel-verify plan-banner" "[dispatch-nebius] === PLAN ===" "$out"
assert_contains "nebius/kernel-verify provision"   "train_nebius.sh provision"      "$out"
assert_contains "nebius/kernel-verify teardown"    "train_nebius.sh teardown"       "$out"

# --- dispatch-nebius.sh, missing --yes-i-will-pay (without --dry-run) -- FAIL --
out="$(NEBIUS_PROJECT_ID="" bash "$HERE/dispatch-nebius.sh" --task train --tier 9b 2>&1)"; rc=$?
if [[ "$rc" != "0" ]]; then
  PASSED=$((PASSED+1)); note "PASS  (nebius/9b without --yes-i-will-pay) refused as expected"
  assert_contains "nebius/no-pay refusal-message" "yes-i-will-pay" "$out"
else
  FAILED=$((FAILED+1)); FAILURES+=("nebius/9b without --yes-i-will-pay should have refused")
  note "FAIL  (nebius/9b no-pay) accepted -- output:"; echo "$out"
fi

# --- run-on-cloud.sh routing -- tier 27b without --provider should pick nebius -
out="$(bash "$HERE/run-on-cloud.sh" --task train --tier 27b --dry-run 2>&1 || true)"
assert_contains "selector/27b auto-route-to-nebius" "[dispatch-nebius] === PLAN ===" "$out"

# --- run-on-cloud.sh routing -- tier 9b without --provider -> recommended=vast -
out="$(bash "$HERE/run-on-cloud.sh" --task train --tier 9b --dry-run 2>&1 || true)"
assert_contains "selector/9b auto-route-to-vast" "[dispatch-vast] === PLAN ===" "$out"

# --- run-on-cloud.sh --help works without args ---------------------------------
out="$(bash "$HERE/run-on-cloud.sh" --help 2>&1)"; rc=$?
if [[ "$rc" == "0" ]]; then
  PASSED=$((PASSED+1)); note "PASS  (selector --help) rc=$rc"
  assert_contains "selector --help mentions usage" "Usage:" "$out"
else
  FAILED=$((FAILED+1)); FAILURES+=("selector --help non-zero")
  note "FAIL  (selector --help) rc=$rc"
fi

# --- summary -------------------------------------------------------------------
note "------------------------------------------"
note "summary: $PASSED passed, $FAILED failed"
if [[ "$FAILED" -gt 0 ]]; then
  for f in "${FAILURES[@]}"; do note "  - $f"; done
  exit 1
fi
exit 0
