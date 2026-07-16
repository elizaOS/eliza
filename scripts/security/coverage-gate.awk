# coverage-gate.awk
#
# Parses LCOV output and computes per-file line coverage. Compares against a
# changed-files list and prints a summary. Exit code is non-zero only when
# enforcement is enabled (COVERAGE_GATE_ENFORCE=1) and any changed file is
# missing from the LCOV report or below the threshold (default 70%).
#
# Usage:
#   awk -v changed="$CHANGED_FILES" -v threshold=70 \
#       [-v excluded="$LCOV_EXCLUDED_FILES"] \
#       -f scripts/security/coverage-gate.awk coverage/lcov.info
#
# `excluded` (newline-separated) lists files that CANNOT appear in an LCOV
# report (coverage collection fails on them; see
# scripts/security/coverage-lcov-excluded.txt, #16409). A changed file on that
# list that is absent from LCOV prints a visible EXCLUDED line instead of the
# fail-closed MISSING. If such a file DOES appear in LCOV (collection got
# fixed), it is gated normally — the escape hatch expires by itself.

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
  # Files that can never appear in LCOV (#16409): absence is expected, not a
  # gate failure. Presence still gates normally.
  if (excluded == "") excluded = ""
  n = split(excluded, parts, "\n")
  for (i = 1; i <= n; i++) {
    if (parts[i] != "") {
      gsub(/\\/, "/", parts[i])
      excluded_map[parts[i]] = 1
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
      # Aggregate per file across ALL lcov inputs BEFORE thresholding. The same
      # source can appear in several lane reports — its own focused lane at real
      # coverage plus another package's lane that merely imports it at ~2%. Keep
      # the file's BEST-lane percentage so an incidental low record cannot fail a
      # file whose real coverage clears the floor (#16043). Counting, the mean,
      # and the below[] verdict are all computed from file_pct in END.
      if (!(matched in file_pct) || pct + 0 > file_pct[matched] + 0) {
        file_pct[matched] = pct
      }
    }
  }
  current = ""; lines_found = 0; lines_hit = 0
}

END {
  missing_count = 0
  changed_count = 0
  changed_sum = 0
  for (f in changed_map) {
    if (!(f in file_pct)) {
      if (f in excluded_map) {
        # Fail-open but VISIBLE: the file is on the reviewed exclusion manifest
        # because coverage collection cannot instrument it (#16409).
        printf "  EXCLUDED (cannot appear in LCOV, see scripts/security/coverage-lcov-excluded.txt): %s\n", f
        continue
      }
      printf "  MISSING: %s\n", f
      missing_count++
    } else {
      changed_count++
      changed_sum += file_pct[f]
      printf "  %6.2f%% %s\n", file_pct[f], f
      if (file_pct[f] + 0 < threshold + 0) below[f] = file_pct[f]
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
