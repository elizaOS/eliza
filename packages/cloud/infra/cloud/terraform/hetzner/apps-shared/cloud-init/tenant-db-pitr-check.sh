#!/usr/bin/env bash
# Verifies current WAL delivery and completed backup freshness for the tenant database.
set -euo pipefail
PG_BACKREST=(/usr/bin/pgbackrest --config=/etc/pgbackrest/eliza-tenant.conf --config-include-path=/etc/pgbackrest/eliza-empty.d --stanza=tenant)
"${PG_BACKREST[@]}" check
"${PG_BACKREST[@]}" --output=json info | jq -e --argjson now "$(date +%s)" '
# Evaluates completed pgBackRest backup receipts for the current stanza database generation.
if type != "array" or length != 1 then error("Expected one tenant stanza") else .[0] end
| if .name != "tenant" or .status.code != 0 then error("Tenant repository is unavailable") else . end
| if (.repo | type) != "array" or (.repo | length) != 1 or .repo[0].key != 1 or .repo[0].status.code != 0 then error("Expected healthy repository 1") else . end
| ([.db[] | select(."repo-key" == 1)] | max_by(.id).id) as $generation
| if ($generation | type) != "number" then error("Current database generation unavailable") else . end
| [.backup[] | select(.database.id == $generation and .database."repo-key" == 1 and .error == false)] as $backups
| ($backups | max_by(.timestamp.stop)) as $latest
| ($backups | map(select(.type == "full")) | max_by(.timestamp.stop)) as $full
| if ($latest.timestamp.stop | type) != "number" or ($full.timestamp.stop | type) != "number" then error("Completed current-generation backup missing") else . end
| if $latest.timestamp.stop > $now or $full.timestamp.stop > $now then error("Backup timestamp is in the future") else . end
| if $now - $latest.timestamp.stop > 93600 then error("Latest backup exceeds 26 hours") else . end
| if $now - $full.timestamp.stop > 777600 then error("Full backup exceeds nine days") else . end
| {stanza: .name, backup: $latest.label, full: $full.label, checked_at: $now}

'
