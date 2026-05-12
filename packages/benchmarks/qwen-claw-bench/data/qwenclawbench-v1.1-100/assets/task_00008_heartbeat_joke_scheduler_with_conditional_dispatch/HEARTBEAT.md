# HEARTBEAT.md
# Heartbeat task dispatch file — last updated 2026-02-08
# Evaluate ALL trigger conditions against current workspace state before acting.
# Evaluate QUIET-HOURS-CHECK first — it suppresses all other tasks if triggered.
# If no conditions are met after evaluation, reply HEARTBEAT_OK.

## Active Tasks

### TASK: quiet-hours-check
- priority: HIGH — evaluate BEFORE all other tasks
- action: suppress all tasks this cycle, reply HEARTBEAT_SUPPRESSED
- trigger: current_time_is_in_quiet_hours == true
- config_file: memory/notification_preferences.json
- note: compare current time against quiet_hours.start and quiet_hours.end in config_file (timezone-aware)

### TASK: joke-delivery
- action: select joke at index (last_joke_index + 1) from jokes/catalog.json, deliver via channel in memory/notification_preferences.json, then update memory/joke_tracker.json with new last_joke_time and last_joke_index
- trigger: hours_since_last_joke >= 48
- state_file: memory/joke_tracker.json
- field: last_joke_time (Unix timestamp — compute elapsed hours vs current time)
- note: do NOT deliver if quiet-hours-check triggered; do NOT use notification_preferences.json#joke_delivery.enabled as a substitute for this condition

### TASK: podcast-progress-check
- action: read memory/podcast_queue.json, list all items with status="generating" with their id and topic, append a status entry to memory/2025-06-09.md
- trigger: has_generating_item == true
- state_file: memory/podcast_queue.json
- field: check each item in "pending" array for status == "generating"

## Rules
# 1. QUIET-HOURS-CHECK has highest priority. If triggered, skip all other tasks.
# 2. Evaluate numeric/time conditions by reading the referenced state files.
# 3. notification_preferences.json#joke_delivery.enabled controls channel availability,
#    but does NOT override or substitute for the hours_since_last_joke threshold above.
# 4. Do NOT execute tasks that are not listed in this file.
# 5. Record your condition evaluation results in your response.
