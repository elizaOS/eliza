# coverage-gate.awk
#
# Enforces per-file LCOV line coverage. Existing files larger than
# delta_min_lines (default 1000) whose additions touch less than
# delta_max_percent (default 5%) are evaluated on instrumentable changed lines.
# New files, broad edits, and changed lines absent from DA records retain the
# whole-file policy. Missing non-excluded source remains a hard failure.
#
# Usage:
#   awk -v changed="$CHANGED_FILES" -v delta="$DELTA_SPEC" -v threshold=50 \
#       [-v delta_min_lines=1000] [-v delta_max_percent=5] \
#       [-v excluded="$LCOV_EXCLUDED_FILES"] \
#       -f scripts/security/coverage-gate.awk coverage/**/lcov.info

BEGIN {
  if (threshold == "") threshold = 70
  if (delta_min_lines == "") delta_min_lines = 1000
  if (delta_max_percent == "") delta_max_percent = 5
  if (changed == "") changed = ""
  n = split(changed, parts, "\n")
  for (i = 1; i <= n; i++) {
    if (parts[i] != "") { gsub(/\\/, "/", parts[i]); changed_map[parts[i]] = 1 }
  }
  if (excluded == "") excluded = ""
  n = split(excluded, parts, "\n")
  for (i = 1; i <= n; i++) {
    if (parts[i] != "") { gsub(/\\/, "/", parts[i]); excluded_map[parts[i]] = 1 }
  }
  if (delta == "") delta = ""
  n = split(delta, rows, "\n")
  for (i = 1; i <= n; i++) {
    fields = split(rows[i], col, "\t")
    if (fields < 3 || col[1] == "") continue
    path = col[1]; gsub(/\\/, "/", path)
    file_lines[path] = col[2] + 0
    file_new[path] = col[3] + 0
    additions = col[4]
    count = split(additions, nums, ",")
    for (j = 1; j <= count; j++) {
      if (nums[j] != "") { changed_line[path SUBSEP (nums[j] + 0)] = 1; changed_line_count[path]++ }
    }
  }
}

function path_matches_lcov(current_path, changed_path,    current_len, changed_len, prefix_len) {
  gsub(/\\/, "/", current_path); gsub(/\\/, "/", changed_path)
  if (current_path == changed_path) return 1
  current_len = length(current_path); changed_len = length(changed_path)
  if (current_len <= changed_len) return 0
  prefix_len = current_len - changed_len
  return substr(current_path, prefix_len + 1) == changed_path && substr(current_path, prefix_len, 1) == "/"
}

/^SF:/ {
  sub(/^SF:/, "", $0); current = $0; lines_found = 0; lines_hit = 0
  matched = ""; matched_len = 0
  for (cf in changed_map) {
    if (path_matches_lcov(current, cf) && length(cf) > matched_len) { matched = cf; matched_len = length(cf) }
  }
}
/^LF:/ { sub(/^LF:/, "", $0); lines_found = $0 + 0 }
/^LH:/ { sub(/^LH:/, "", $0); lines_hit = $0 + 0 }
/^DA:/ {
  if (matched == "") next
  value = $0; sub(/^DA:/, "", value); split(value, da, ",")
  line = da[1] + 0; hits = da[2] + 0
  if (changed_line[matched SUBSEP line]) {
    lane_delta_found[matched]++
    if (hits > 0) lane_delta_hit[matched]++
  }
}
/^end_of_record/ {
  if (matched != "" && lines_found > 0) {
    pct = (lines_hit / lines_found) * 100
    if (!(matched in file_pct) || pct > file_pct[matched]) file_pct[matched] = pct
    if (lane_delta_found[matched] > 0) {
      delta_pct = (lane_delta_hit[matched] / lane_delta_found[matched]) * 100
      if (!(matched in file_delta_pct) || delta_pct > file_delta_pct[matched]) {
        file_delta_pct[matched] = delta_pct
        file_delta_found[matched] = lane_delta_found[matched]
      }
    }
  }
  current = ""; matched = ""; lines_found = 0; lines_hit = 0
  # These counts are lane-local. Reset all keys because LCOV records are serial.
  for (key in lane_delta_found) delete lane_delta_found[key]
  for (key in lane_delta_hit) delete lane_delta_hit[key]
}

END {
  missing_count = 0; changed_count = 0; changed_sum = 0
  for (f in changed_map) {
    if (!(f in file_pct)) {
      if (f in excluded_map) {
        printf "  EXCLUDED (cannot appear in LCOV, see scripts/security/coverage-lcov-excluded.txt): %s\n", f
        continue
      }
      printf "  MISSING: %s\n", f; missing_count++; continue
    }
    changed_count++
    use_delta = file_new[f] == 0 && file_lines[f] > delta_min_lines && changed_line_count[f] > 0 && (changed_line_count[f] * 100 / file_lines[f]) < delta_max_percent && (f in file_delta_pct)
    if (use_delta) {
      pct = file_delta_pct[f]
      printf "  %6.2f%% %s (changed-line mode: %d instrumentable of %d changed lines, %d total lines)\n", pct, f, file_delta_found[f], changed_line_count[f], file_lines[f]
    } else {
      pct = file_pct[f]
      reason = ""
      if (file_new[f]) reason = "new file"
      else if (file_lines[f] > delta_min_lines && changed_line_count[f] > 0 && (changed_line_count[f] * 100 / file_lines[f]) < delta_max_percent && !(f in file_delta_pct)) reason = "changed lines non-instrumentable; whole-file fallback"
      printf "  %6.2f%% %s%s\n", pct, f, (reason == "" ? "" : " (" reason ")")
    }
    changed_sum += pct
    if (pct < threshold) below[f] = pct
  }
  if (changed_count == 0) print "no changed files matched the LCOV report"
  else printf "\nchanged files: %d, mean enforced coverage: %.2f%%, threshold: %d%%\n", changed_count, changed_sum / changed_count, threshold
  fail = missing_count > 0
  for (f in below) { printf "  BELOW: %s (%.2f%%)\n", f, below[f]; fail = 1 }
  if (fail && ENVIRON["COVERAGE_GATE_ENFORCE"] == "1") {
    if (missing_count > 0) print "coverage gate FAILED (changed source missing from LCOV)"
    else print "coverage gate FAILED (enforcement enabled)"
    exit 1
  }
  if (fail) print "coverage gate ADVISORY (set COVERAGE_GATE_ENFORCE=1 to require)"
  else print "coverage gate OK"
}
