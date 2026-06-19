# coverage-gate.awk
#
# Parses LCOV output and computes per-file line coverage. Compares against a
# changed-files list and prints a summary. Exit code is non-zero only when
# enforcement is enabled (COVERAGE_GATE_ENFORCE=1) and any changed file is
# below the threshold (default 70%).
#
# Usage:
#   awk -v changed="$CHANGED_FILES" -v threshold=70 \
#       -f scripts/security/coverage-gate.awk coverage/lcov.info

BEGIN {
  if (threshold == "") threshold = 70
  if (changed == "") changed = ""
  # Split changed files into a lookup table.
  n = split(changed, parts, "\n")
  for (i = 1; i <= n; i++) {
    if (parts[i] != "") changed_map[parts[i]] = 1
  }
}

/^SF:/ {
  sub(/^SF:/, "", $0)
  current = $0
  lines_found = 0
  lines_hit = 0
}

/^LF:/ {
  sub(/^LF:/, "", $0)
  lines_found = $0 + 0
}

/^LH:/ {
  sub(/^LH:/, "", $0)
  lines_hit = $0 + 0
}

/^end_of_record/ {
  if (lines_found > 0) {
    pct = (lines_hit / lines_found) * 100
    # Check if this file is in changed list (suffix match, since lcov paths
    # may be absolute and the changed list is relative).
    matched = ""
    for (cf in changed_map) {
      if (index(current, cf) > 0) { matched = cf; break }
    }
    if (matched != "") {
      changed_count++
      changed_sum += pct
      printf "  %6.2f%% %s\n", pct, matched
      if (pct + 0 < threshold + 0) below[matched] = pct
    }
  }
  current = ""; lines_found = 0; lines_hit = 0
}

END {
  if (changed_count == 0) {
    print "no changed files matched the LCOV report (nothing to gate)"
    exit 0
  }
  avg = changed_sum / changed_count
  printf "\nchanged files: %d, mean coverage: %.2f%%, threshold: %d%%\n", \
    changed_count, avg, threshold

  fail = 0
  for (f in below) {
    printf "  BELOW: %s (%.2f%%)\n", f, below[f]
    fail = 1
  }
  if (fail && ENVIRON["COVERAGE_GATE_ENFORCE"] == "1") {
    print "coverage gate FAILED (enforcement enabled)"
    exit 1
  }
  if (fail) {
    print "coverage gate ADVISORY (set COVERAGE_GATE_ENFORCE=1 to require)"
  } else {
    print "coverage gate OK"
  }
}
