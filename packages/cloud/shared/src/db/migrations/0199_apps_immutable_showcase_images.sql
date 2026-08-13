UPDATE "apps"
SET "metadata" = jsonb_set(
  "metadata",
  '{imageTag}',
  '"ghcr.io/elizaos/example-edad@sha256:2c68b639eec00fad1b35e978f5463f1543b392c96680ec496fd0c0a9eddc8241"'::jsonb,
  false
)
WHERE "metadata"->>'imageTag' = 'ghcr.io/elizaos/example-edad:showcase';
--> statement-breakpoint
UPDATE "apps"
SET "metadata" = jsonb_set(
  "metadata",
  '{imageTag}',
  '"ghcr.io/elizaos/example-clone-ur-crush@sha256:b7e5fd1310a56158ea47ea923eccc7ae4ca067b177bea0cd326d32c4129b60db"'::jsonb,
  false
)
WHERE "metadata"->>'imageTag' = 'ghcr.io/elizaos/example-clone-ur-crush:showcase';
