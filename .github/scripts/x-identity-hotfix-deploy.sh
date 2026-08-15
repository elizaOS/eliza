#!/usr/bin/env bash
# Inspects the live Eliza X sandbox and stored X conversation ownership metadata.
set -euo pipefail

agent_id=4602b3be-2c01-4e7e-9cdc-849604e1bef7
database_url="$(sed -n 's/^DATABASE_URL=//p' /opt/eliza/cloud/.env.local | tail -1)"
database_url="${database_url/sslmode=no-verify/sslmode=require}"

psql "$database_url" -v ON_ERROR_STOP=1 -P pager=off <<SQL
SELECT id, status, node_id, container_name, headscale_ip, docker_image
FROM agent_sandboxes
WHERE id = '$agent_id';

SELECT r.id AS room_id, r.source, r.type, r.world_id,
       w.metadata->'ownership' AS ownership,
       w.metadata->'twitter' AS twitter
FROM rooms AS r
LEFT JOIN worlds AS w ON w.id = r.world_id
WHERE r.agent_id = 'b850bc30-45f8-0041-a00a-83df46d8555d'
  AND (r.id = '47f5526f-c192-04ca-aa63-12283ea6f010'
       OR w.metadata->'twitter'->>'id' IN ('1519007261917650945', '1830340867737178112'))
ORDER BY r.created_at DESC;

SELECT id, name, metadata->'ownership' AS ownership,
       metadata->'twitter' AS twitter
FROM worlds
WHERE agent_id = 'b850bc30-45f8-0041-a00a-83df46d8555d'
  AND metadata->'twitter'->>'id' IN ('1519007261917650945', '1830340867737178112')
ORDER BY created_at DESC;

SELECT id, status, error
FROM jobs
WHERE agent_id = '$agent_id'
ORDER BY created_at DESC
LIMIT 4;
SQL
