# coverage-gate.awk
#
# Parses LCOV output and computes per-file line coverage. Compares against a
# changed-files list and prints a summary. Exit code is non-zero only when
# enforcement is enabled (COVERAGE_GATE_ENFORCE=1) and any changed file is
# missing from the LCOV report or below the threshold (default 70%).
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
    if (parts[i] != "") {
      gsub(/\\/, "/", parts[i])
      changed_map[parts[i]] = 1
    }
  }
}

function path_matches_lcov(current_path, changed_path,    current_len, changed_len, prefix_len) {
  gsub(/\\/, "/", current_path)
  gsub(/\\/, "/", changed_path)
  if (current_path == changed_path) return 1

  current_len = length(current_path)
  changed_len = length(changed_path)
  if (current_len <= changed_len) return 0

  prefix_len = current_len - changed_len
  return \
    substr(current_path, prefix_len + 1) == changed_path && \
    substr(current_path, prefix_len, 1) == "/"
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
    # LCOV paths may be absolute while the changed list is repo-relative. Pick
    # the longest exact path-segment suffix so overlaps are deterministic.
    matched = ""
    matched_len = 0
    for (cf in changed_map) {
      if (path_matches_lcov(current, cf) && length(cf) > matched_len) {
        matched = cf
        matched_len = length(cf)
      }
    }
    if (matched != "") {
      matched_map[matched] = 1
      changed_count++
      changed_sum += pct
      printf "  %6.2f%% %s\n", pct, matched
      if (pct + 0 < threshold + 0) below[matched] = pct
    }
  }
  current = ""; lines_found = 0; lines_hit = 0
}

END {
  missing_count = 0
  for (f in changed_map) {
    if (!(f in matched_map)) {
      printf "  MISSING: %s\n", f
      missing_count++
    }
  }

  if (changed_count == 0) {
    print "no changed files matched the LCOV report"
  } else {
    avg = changed_sum / changed_count
    printf "\nchanged files: %d, mean coverage: %.2f%%, threshold: %d%%\n", \
      changed_count, avg, threshold
  }

  fail = missing_count > 0
  for (f in below) {
    printf "  BELOW: %s (%.2f%%)\n", f, below[f]
    fail = 1
  }
  if (fail && ENVIRON["COVERAGE_GATE_ENFORCE"] == "1") {
    if (missing_count > 0) {
      print "coverage gate FAILED (changed source missing from LCOV)"
    } else {
      print "coverage gate FAILED (enforcement enabled)"
    }
    exit 1
  }
  if (fail) {
    print "coverage gate ADVISORY (set COVERAGE_GATE_ENFORCE=1 to require)"
  } else {
    print "coverage gate OK"
  }
}
