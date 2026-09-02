-- Raw-SQL authority for restore-v3 isolated candidates. Begin and seal lock
-- live authorities in one canonical order; terminal state is reachable only
-- through an append-only command. The only DELETE path is a 30-day, terminal,
-- cleanup-proven GC tombstone which remains permanently.

CREATE OR REPLACE FUNCTION "agent_backup_restore_v3_sha256_text"(value text)
RETURNS text LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT encode(sha256(convert_to(value, 'UTF8')), 'hex')
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "lock_agent_backup_restore_v3_attempt"(
  p_organization_id uuid,
  p_restore_attempt_id uuid
) RETURNS void LANGUAGE plpgsql VOLATILE STRICT PARALLEL UNSAFE AS $$
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'restore-v3 attempt fencing requires read committed isolation'
      USING ERRCODE = '55000';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'eliza:agent-backup-restore-v3-attempt:v1:' || p_organization_id::text || ':' ||
      p_restore_attempt_id::text,
    0
  ));
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "reject_agent_backup_restore_v3_candidate_truncate"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'restore-v3 candidate authority cannot be truncated: %', TG_TABLE_NAME
    USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "lock_agent_backup_restore_v3_current_authority"(
  p_organization_id uuid,
  p_agent_id uuid,
  p_backup_id uuid,
  p_restore_attempt_id uuid,
  p_operation_id uuid,
  p_restore_operation_id uuid,
  p_lease_id uuid,
  p_lease_owner_id text,
  p_lease_generation uuid,
  p_catalog_epoch bigint,
  p_copy_role text,
  p_source_activation_generation uuid,
  p_source_lifecycle_revision numeric,
  p_expected_manifest_sha256 text,
  p_key_bundle_generation_id uuid,
  p_source_authority_canonical text,
  p_source_authority_sha256 text,
  p_object_count integer,
  p_lease_expires_snapshot timestamptz DEFAULT NULL
) RETURNS timestamptz LANGUAGE plpgsql AS $$
DECLARE
  current_lease_expires_at timestamptz;
  observed_at timestamptz;
  source jsonb;
  source_object jsonb;
  source_catalog jsonb;
  source_object_id uuid;
  source_component_index integer;
  source_component_name text;
  source_chunk_index integer;
  expected_component_name text;
  previous_component_index integer := -1;
  previous_chunk_index integer := -1;
  seen_object_ids uuid[] := ARRAY[]::uuid[];
  seen_key_fingerprints text[] := ARRAY[]::text[];
  source_object_count integer := 0;
  current_object_count integer;
BEGIN
  IF octet_length(p_source_authority_canonical) NOT BETWEEN 2 AND 16777216
    OR p_source_authority_sha256 !~ '^[0-9a-f]{64}$'
    OR p_object_count NOT BETWEEN 1 AND 8192 THEN
    RAISE EXCEPTION 'restore-v3 source authority exceeds its hard metadata bounds'
      USING ERRCODE = '55000';
  END IF;
  -- Canonical order: backup -> operation -> lease -> catalogue -> objects.
  PERFORM 1
  FROM "agent_sandbox_backups" AS backup
  WHERE backup."id" = p_backup_id
    AND backup."catalog_organization_id" = p_organization_id
    AND backup."catalog_agent_id" = p_agent_id
    AND backup."backup_operation_id" = p_operation_id
    AND backup."lifecycle_generation" = p_source_activation_generation
    AND backup."lifecycle_revision" = p_source_lifecycle_revision
    AND backup."manifest_digest" = p_expected_manifest_sha256
    AND backup."operation_key_bundle_generation_id" = p_key_bundle_generation_id
    AND backup."catalog_state" IN ('protected', 'retained', 'restore_verified')
    AND backup."manifest_version" = 3
  -- FOR UPDATE also fences FK-backed object insertion while this generation is checked.
  FOR UPDATE OF backup;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'restore-v3 source backup authority is no longer current'
      USING ERRCODE = '55000';
  END IF;

  PERFORM 1
  FROM "agent_backup_restore_operations" AS operation
  WHERE operation."id" = p_restore_operation_id
    AND operation."organization_id" = p_organization_id
    AND operation."agent_id" = p_agent_id
    AND operation."backup_id" = p_backup_id
    AND operation."restore_attempt_id" = p_restore_attempt_id
    AND operation."lease_id" = p_lease_id
    AND operation."lease_owner_id" = p_lease_owner_id
    AND operation."lease_generation" = p_lease_generation
    AND operation."catalog_epoch" = p_catalog_epoch
    AND operation."copy_role" = p_copy_role
    AND operation."expected_operation_id" = p_operation_id
    AND operation."expected_activation_generation" = p_source_activation_generation
    AND operation."expected_lifecycle_revision" = p_source_lifecycle_revision
    AND operation."expected_manifest_sha256" = p_expected_manifest_sha256
    AND operation."phase" NOT IN ('finalized', 'failed_terminal')
  FOR UPDATE OF operation;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'restore-v3 operation authority is no longer open'
      USING ERRCODE = '55000';
  END IF;

  SELECT lease."expires_at" INTO current_lease_expires_at
  FROM "agent_backup_restore_leases" AS lease
  WHERE lease."id" = p_lease_id
    AND lease."organization_id" = p_organization_id
    AND lease."agent_id" = p_agent_id
    AND lease."backup_id" = p_backup_id
    AND lease."restore_attempt_id" = p_restore_attempt_id
    AND lease."owner_id" = p_lease_owner_id
    AND lease."generation" = p_lease_generation
    AND lease."catalog_epoch" = p_catalog_epoch
    AND lease."copy_role" = p_copy_role
    AND lease."operation_id" = p_operation_id
    AND lease."activation_generation" = p_source_activation_generation
    AND lease."lifecycle_revision" = p_source_lifecycle_revision
    AND lease."expected_manifest_sha256" = p_expected_manifest_sha256
    AND lease."released_at" IS NULL
  FOR NO KEY UPDATE OF lease;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'restore-v3 lease authority is released, stale, or expired'
      USING ERRCODE = '55000';
  END IF;

  PERFORM 1
  FROM "agent_backup_catalog_authorities" AS authority
  WHERE authority."organization_id" = p_organization_id
    AND authority."agent_id" = p_agent_id
    AND authority."catalog_revision" = p_catalog_epoch
  FOR NO KEY UPDATE OF authority;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'restore-v3 catalogue epoch is stale'
      USING ERRCODE = '55000';
  END IF;

  -- Lock the whole selected copy before interpreting its canonical projection.
  PERFORM object."id"
  FROM "agent_backup_objects" AS object
  WHERE object."organization_id" = p_organization_id
    AND object."backup_id" = p_backup_id
    AND object."copy_role" = p_copy_role
  ORDER BY CASE object."component"
      WHEN 'character' THEN 0 WHEN 'database' THEN 1 WHEN 'media' THEN 2
      WHEN 'state-files' THEN 3 WHEN 'vault' THEN 4 ELSE 32767 END,
    object."chunk_index", object."id"
  FOR NO KEY UPDATE OF object;

  IF "agent_backup_restore_v3_sha256_text"(p_source_authority_canonical)
      <> p_source_authority_sha256 THEN
    RAISE EXCEPTION 'restore-v3 source authority digest differs from its canonical bytes'
      USING ERRCODE = '55000';
  END IF;
  BEGIN
    source := p_source_authority_canonical::jsonb;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'restore-v3 source authority is not valid JSON'
      USING ERRCODE = '55000';
  END;
  IF jsonb_typeof(source) <> 'object'
    OR NOT (source ?& ARRAY[
      'derivation', 'organizationId', 'agentId', 'backupId', 'operationId',
      'sourceActivationGeneration', 'sourceLifecycleRevision',
      'expectedManifestSha256', 'copyRole', 'catalogEpoch', 'objects'])
    OR (source - ARRAY[
      'derivation', 'organizationId', 'agentId', 'backupId', 'operationId',
      'sourceActivationGeneration', 'sourceLifecycleRevision',
      'expectedManifestSha256', 'copyRole', 'catalogEpoch', 'objects']) <> '{}'::jsonb
    OR jsonb_typeof(source->'derivation') <> 'string'
    OR jsonb_typeof(source->'organizationId') <> 'string'
    OR jsonb_typeof(source->'agentId') <> 'string'
    OR jsonb_typeof(source->'backupId') <> 'string'
    OR jsonb_typeof(source->'operationId') <> 'string'
    OR jsonb_typeof(source->'sourceActivationGeneration') <> 'string'
    OR jsonb_typeof(source->'sourceLifecycleRevision') <> 'string'
    OR jsonb_typeof(source->'expectedManifestSha256') <> 'string'
    OR jsonb_typeof(source->'copyRole') <> 'string'
    OR jsonb_typeof(source->'catalogEpoch') <> 'string'
    OR source->>'derivation' <> 'elizaos.agent-backup.restore-v3-source-authority.v1'
    OR source->>'organizationId' <> p_organization_id::text
    OR source->>'agentId' <> p_agent_id::text
    OR source->>'backupId' <> p_backup_id::text
    OR source->>'operationId' <> p_operation_id::text
    OR source->>'sourceActivationGeneration' <> p_source_activation_generation::text
    OR source->>'sourceLifecycleRevision' <> p_source_lifecycle_revision::text
    OR source->>'expectedManifestSha256' <> p_expected_manifest_sha256
    OR source->>'copyRole' <> p_copy_role
    OR source->>'catalogEpoch' <> p_catalog_epoch::text
    OR jsonb_typeof(source->'objects') <> 'array'
    OR jsonb_array_length(source->'objects') <> p_object_count THEN
    RAISE EXCEPTION 'restore-v3 source authority structure or scalar binding is invalid'
      USING ERRCODE = '55000';
  END IF;

  FOR source_object IN
    SELECT value FROM jsonb_array_elements(source->'objects') WITH ORDINALITY
    ORDER BY ordinality
  LOOP
    source_object_count := source_object_count + 1;
    IF jsonb_typeof(source_object) <> 'object'
      OR NOT (source_object ?& ARRAY[
        'objectId', 'componentIndex', 'componentName', 'chunkIndex',
        'copyRole', 'contentHmacSha256', 'catalog'])
      OR (source_object - ARRAY[
        'objectId', 'componentIndex', 'componentName', 'chunkIndex',
        'copyRole', 'contentHmacSha256', 'catalog']) <> '{}'::jsonb
      OR jsonb_typeof(source_object->'objectId') <> 'string'
      OR jsonb_typeof(source_object->'componentIndex') <> 'number'
      OR jsonb_typeof(source_object->'componentName') <> 'string'
      OR jsonb_typeof(source_object->'chunkIndex') <> 'number'
      OR jsonb_typeof(source_object->'copyRole') <> 'string'
      OR jsonb_typeof(source_object->'contentHmacSha256') <> 'string'
      OR jsonb_typeof(source_object->'catalog') <> 'object'
      OR (source_object->>'objectId') !~
        '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      OR (source_object->>'contentHmacSha256') !~ '^[0-9a-f]{64}$' THEN
      RAISE EXCEPTION 'restore-v3 source object structure is invalid'
        USING ERRCODE = '55000';
    END IF;
    BEGIN
      source_object_id := (source_object->>'objectId')::uuid;
      source_component_index := (source_object->>'componentIndex')::integer;
      source_chunk_index := (source_object->>'chunkIndex')::integer;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'restore-v3 source object scalar is non-canonical'
        USING ERRCODE = '55000';
    END;
    source_component_name := source_object->>'componentName';
    expected_component_name := CASE source_component_index
      WHEN 0 THEN 'character' WHEN 1 THEN 'database' WHEN 2 THEN 'media'
      WHEN 3 THEN 'state-files' WHEN 4 THEN 'vault' ELSE NULL END;
    IF expected_component_name IS NULL
      OR source_component_name <> expected_component_name
      OR source_object->>'copyRole' <> p_copy_role
      OR source_chunk_index NOT BETWEEN 0 AND 4095
      OR source_component_index < previous_component_index
      OR (source_component_index = previous_component_index
        AND source_chunk_index <> previous_chunk_index + 1)
      OR (source_component_index > previous_component_index
        AND (source_component_index <> previous_component_index + 1 OR source_chunk_index <> 0))
      OR source_object_id = ANY(seen_object_ids) THEN
      RAISE EXCEPTION 'restore-v3 source objects are not exact, unique, and contiguous'
        USING ERRCODE = '55000';
    END IF;
    seen_object_ids := array_append(seen_object_ids, source_object_id);
    previous_component_index := source_component_index;
    previous_chunk_index := source_chunk_index;
    source_catalog := source_object->'catalog';
    IF NOT (source_catalog ?& ARRAY[
        'transport', 'provider', 'endpointIdentityFingerprint',
        'endpointAliasFingerprint', 'bucketFingerprint', 'regionFingerprint',
        'keyFingerprint', 'providerVersionId', 'providerEtag', 'providerChecksum',
        'uploadReceiptDigest', 'ciphertextSha256', 'sizeBytes'])
      OR (source_catalog - ARRAY[
        'transport', 'provider', 'endpointIdentityFingerprint',
        'endpointAliasFingerprint', 'bucketFingerprint', 'regionFingerprint',
        'keyFingerprint', 'providerVersionId', 'providerEtag', 'providerChecksum',
        'uploadReceiptDigest', 'ciphertextSha256', 'sizeBytes']) <> '{}'::jsonb
      OR jsonb_typeof(source_catalog->'transport') <> 'string'
      OR jsonb_typeof(source_catalog->'provider') <> 'string'
      OR jsonb_typeof(source_catalog->'endpointIdentityFingerprint') <> 'string'
      OR jsonb_typeof(source_catalog->'endpointAliasFingerprint') <> 'string'
      OR jsonb_typeof(source_catalog->'bucketFingerprint') <> 'string'
      OR jsonb_typeof(source_catalog->'regionFingerprint') <> 'string'
      OR jsonb_typeof(source_catalog->'keyFingerprint') <> 'string'
      OR jsonb_typeof(source_catalog->'providerVersionId') NOT IN ('string', 'null')
      OR jsonb_typeof(source_catalog->'providerEtag') NOT IN ('string', 'null')
      OR jsonb_typeof(source_catalog->'providerChecksum') NOT IN ('string', 'null')
      OR jsonb_typeof(source_catalog->'uploadReceiptDigest') <> 'string'
      OR jsonb_typeof(source_catalog->'ciphertextSha256') <> 'string'
      OR jsonb_typeof(source_catalog->'sizeBytes') <> 'number'
      OR source_catalog->>'transport' NOT IN ('worker-r2', 's3-compatible')
      OR source_catalog->>'provider' NOT IN ('cloudflare-r2', 'hetzner-object-storage')
      OR NOT ((p_copy_role = 'primary'
          AND source_catalog->>'provider' = 'cloudflare-r2'
          AND source_catalog->>'transport' IN ('worker-r2', 's3-compatible'))
        OR (p_copy_role = 'secondary'
          AND source_catalog->>'provider' = 'hetzner-object-storage'
          AND source_catalog->>'transport' = 's3-compatible'))
      OR (source_catalog->>'endpointIdentityFingerprint') !~ '^sha256:[0-9a-f]{64}$'
      OR (source_catalog->>'endpointAliasFingerprint') !~ '^sha256:[0-9a-f]{64}$'
      OR (source_catalog->>'bucketFingerprint') !~ '^sha256:[0-9a-f]{64}$'
      OR (source_catalog->>'regionFingerprint') !~ '^sha256:[0-9a-f]{64}$'
      OR (source_catalog->>'keyFingerprint') !~ '^sha256:[0-9a-f]{64}$'
      OR (source_catalog->>'uploadReceiptDigest') !~ '^[0-9a-f]{64}$'
      OR (source_catalog->>'ciphertextSha256') !~ '^[0-9a-f]{64}$'
      OR (source_catalog->>'providerChecksum' IS NOT NULL
        AND source_catalog->>'providerChecksum'
          !~ '^sha256:base64:[A-Za-z0-9+/]{43}=$')
      OR (source_catalog->>'providerVersionId' IS NOT NULL
        AND (btrim(source_catalog->>'providerVersionId')
            <> source_catalog->>'providerVersionId'
          OR source_catalog->>'providerVersionId' ~ '[[:cntrl:]]'
          OR octet_length(source_catalog->>'providerVersionId') NOT BETWEEN 1 AND 2048))
      OR (source_catalog->>'providerEtag' IS NOT NULL
        AND (btrim(source_catalog->>'providerEtag') <> source_catalog->>'providerEtag'
          OR source_catalog->>'providerEtag' ~ '[[:cntrl:]]'
          OR octet_length(source_catalog->>'providerEtag') NOT BETWEEN 1 AND 2048))
      OR (source_catalog->>'sizeBytes') !~ '^[1-9][0-9]*$'
      OR (source_catalog->>'sizeBytes')::numeric > 17825820
      OR (source_catalog->>'providerVersionId' IS NULL
        AND source_catalog->>'providerEtag' IS NULL
        AND source_catalog->>'providerChecksum' IS NULL) THEN
      RAISE EXCEPTION 'restore-v3 source catalogue projection is invalid'
        USING ERRCODE = '55000';
    END IF;
    IF source_catalog->>'keyFingerprint' = ANY(seen_key_fingerprints) THEN
      RAISE EXCEPTION 'restore-v3 source catalogue key fingerprints must be unique'
        USING ERRCODE = '55000';
    END IF;
    seen_key_fingerprints := array_append(
      seen_key_fingerprints,
      source_catalog->>'keyFingerprint'
    );

    PERFORM 1
    FROM "agent_backup_objects" AS object
    WHERE object."id" = source_object_id
      AND object."organization_id" = p_organization_id
      AND object."backup_id" = p_backup_id
      AND object."copy_role" = p_copy_role
      AND object."component" = source_component_name
      AND object."chunk_index" = source_chunk_index
      AND object."state" = 'verified'
      AND object."provider_write_started"
      AND object."verified_at" IS NOT NULL
      AND object."content_hmac_sha256" = source_object->>'contentHmacSha256'
      AND object."transport" = source_catalog->>'transport'
      AND object."provider" = source_catalog->>'provider'
      AND object."endpoint_identity_fingerprint" =
        source_catalog->>'endpointIdentityFingerprint'
      AND 'sha256:' || "agent_backup_restore_v3_sha256_text"(object."endpoint_alias") =
        source_catalog->>'endpointAliasFingerprint'
      AND 'sha256:' || "agent_backup_restore_v3_sha256_text"(object."bucket") =
        source_catalog->>'bucketFingerprint'
      AND 'sha256:' || "agent_backup_restore_v3_sha256_text"(object."region") =
        source_catalog->>'regionFingerprint'
      AND 'sha256:' || object."key_fingerprint" = source_catalog->>'keyFingerprint'
      AND object."provider_version_id" IS NOT DISTINCT FROM
        source_catalog->>'providerVersionId'
      AND object."provider_etag" IS NOT DISTINCT FROM source_catalog->>'providerEtag'
      AND object."provider_checksum" IS NOT DISTINCT FROM source_catalog->>'providerChecksum'
      AND object."upload_receipt_digest" = source_catalog->>'uploadReceiptDigest'
      AND object."ciphertext_sha256" = source_catalog->>'ciphertextSha256'
      AND object."size_bytes" = (source_catalog->>'sizeBytes')::bigint
    FOR NO KEY UPDATE OF object;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'restore-v3 source object differs from current catalogue authority: %',
        source_object_id USING ERRCODE = '55000';
    END IF;
  END LOOP;
  IF source_object_count <> p_object_count OR previous_component_index <> 4 THEN
    RAISE EXCEPTION 'restore-v3 source authority does not cover all five components'
      USING ERRCODE = '55000';
  END IF;
  SELECT count(*)::integer INTO current_object_count
  FROM "agent_backup_objects" AS object
  WHERE object."organization_id" = p_organization_id
    AND object."backup_id" = p_backup_id
    AND object."copy_role" = p_copy_role;
  IF current_object_count <> p_object_count THEN
    RAISE EXCEPTION 'restore-v3 selected copy contains an unbound catalogue object'
      USING ERRCODE = '55000';
  END IF;
  -- Use the wall clock only after every authority lock has been acquired. A
  -- statement timestamp predates lock waits and can therefore bless a lease
  -- which expired while this transaction was blocked.
  observed_at := clock_timestamp();
  IF current_lease_expires_at <= observed_at THEN
    RAISE EXCEPTION 'restore-v3 lease authority is released, stale, or expired'
      USING ERRCODE = '55000';
  END IF;
  IF p_lease_expires_snapshot IS NOT NULL
    AND (p_lease_expires_snapshot <= observed_at
      OR p_lease_expires_snapshot > current_lease_expires_at) THEN
    RAISE EXCEPTION 'restore-v3 lease expiry snapshot is not current'
      USING ERRCODE = '55000';
  END IF;
  RETURN current_lease_expires_at;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "guard_agent_backup_restore_v3_cleanup_outbox"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1
      AND current_setting('eliza.restore_v3_gc_candidate', true) = OLD."restore_attempt_id"::text
      AND current_setting('eliza.restore_v3_gc_cleanup', true) = OLD."id"::text
      AND OLD."state" IN ('completed', 'quarantined') THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'restore-v3 candidate cleanup cannot be deleted: %', OLD."id"
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' THEN
    PERFORM "lock_agent_backup_restore_v3_attempt"(
      NEW."organization_id", NEW."restore_attempt_id");
    IF EXISTS (
      SELECT 1 FROM "agent_backup_restore_v3_candidate_gc_tombstones" AS tombstone
      WHERE tombstone."organization_id" = NEW."organization_id"
        AND tombstone."restore_attempt_id" = NEW."restore_attempt_id"
    ) THEN
      RAISE EXCEPTION 'restore-v3 restore attempt is permanently closed by GC tombstone'
        USING ERRCODE = '55000';
    END IF;
    IF NEW."state" <> 'armed' OR NEW."attempts" <> 0
      OR NEW."claim_owner" IS NOT NULL OR NEW."claim_generation" IS NOT NULL
      OR NEW."lease_expires_at" IS NOT NULL
      OR NEW."next_attempt_at" < NEW."created_at" THEN
      RAISE EXCEPTION 'restore-v3 cleanup must enter armed and unclaimed'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW."id", NEW."organization_id", NEW."agent_id", NEW."backup_id",
      NEW."restore_attempt_id", NEW."operation_id", NEW."cleanup_command_sha256",
      NEW."created_at") IS DISTINCT FROM
    ROW(OLD."id", OLD."organization_id", OLD."agent_id", OLD."backup_id",
      OLD."restore_attempt_id", OLD."operation_id", OLD."cleanup_command_sha256",
      OLD."created_at") THEN
    RAISE EXCEPTION 'restore-v3 cleanup identity is immutable: %', OLD."id"
      USING ERRCODE = '55000';
  END IF;
  IF OLD."state" IN ('completed', 'quarantined') THEN
    IF NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'restore-v3 cleanup is terminal in state %: %', OLD."state", OLD."id"
        USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;
  IF NOT (
    (OLD."state" = 'armed' AND NEW."state" IN ('armed', 'held', 'pending', 'quarantined'))
    OR (OLD."state" = 'held' AND NEW."state" IN ('held', 'pending', 'quarantined'))
    OR (OLD."state" = 'pending' AND NEW."state" IN ('pending', 'leased', 'quarantined'))
    OR (OLD."state" = 'leased'
      AND NEW."state" IN ('leased', 'pending', 'completed', 'quarantined'))
  ) THEN
    RAISE EXCEPTION 'invalid restore-v3 cleanup transition: % -> %', OLD."state", NEW."state"
      USING ERRCODE = '55000';
  END IF;
  IF NEW."next_attempt_at" < OLD."next_attempt_at" THEN
    RAISE EXCEPTION 'restore-v3 cleanup readiness cannot move backward: %', OLD."id"
      USING ERRCODE = '55000';
  END IF;
  IF OLD."state" = 'pending' AND NEW."state" = 'leased' THEN
    IF NEW."attempts" <> OLD."attempts" + 1
      OR NEW."lease_expires_at" <= clock_timestamp() THEN
      RAISE EXCEPTION 'restore-v3 cleanup claim requires one attempt and a live lease: %', OLD."id"
        USING ERRCODE = '55000';
    END IF;
  ELSIF NEW."attempts" IS DISTINCT FROM OLD."attempts" THEN
    RAISE EXCEPTION 'restore-v3 cleanup attempts change only on pending to leased: %', OLD."id"
      USING ERRCODE = '55000';
  END IF;
  IF OLD."state" = 'leased' AND NEW."state" = 'leased' AND (
      NEW."claim_owner" IS DISTINCT FROM OLD."claim_owner"
      OR NEW."claim_generation" IS DISTINCT FROM OLD."claim_generation"
      OR NEW."lease_expires_at" < OLD."lease_expires_at"
      OR NEW."lease_expires_at" <= clock_timestamp()) THEN
    RAISE EXCEPTION 'restore-v3 cleanup lease must preserve its fence and horizon: %', OLD."id"
      USING ERRCODE = '55000';
  END IF;
  IF NEW."state" = 'completed' THEN
    NEW."completed_at" := statement_timestamp();
  ELSIF NEW."state" = 'quarantined' THEN
    NEW."quarantined_at" := statement_timestamp();
  END IF;
  NEW."updated_at" := statement_timestamp();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "guard_agent_backup_restore_v3_candidate"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  cleanup_state text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1
      AND current_setting('eliza.restore_v3_gc_candidate', true) = OLD."restore_attempt_id"::text
      AND OLD."state" IN ('sealed', 'aborted')
      AND OLD."retention_until" <= statement_timestamp() THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'restore-v3 candidate cannot be deleted: %', OLD."id"
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."state" <> 'active' THEN
      RAISE EXCEPTION 'restore-v3 candidate must enter active'
        USING ERRCODE = '55000';
    END IF;
    PERFORM "lock_agent_backup_restore_v3_attempt"(
      NEW."organization_id", NEW."restore_attempt_id");
    IF EXISTS (
      SELECT 1 FROM "agent_backup_restore_v3_candidate_gc_tombstones" AS tombstone
      WHERE tombstone."organization_id" = NEW."organization_id"
        AND tombstone."restore_attempt_id" = NEW."restore_attempt_id"
    ) THEN
      RAISE EXCEPTION 'restore-v3 restore attempt is permanently closed by GC tombstone'
        USING ERRCODE = '55000';
    END IF;
    PERFORM "lock_agent_backup_restore_v3_current_authority"(
      NEW."organization_id", NEW."agent_id", NEW."backup_id", NEW."restore_attempt_id",
      NEW."operation_id", NEW."restore_operation_id", NEW."lease_id", NEW."lease_owner_id",
      NEW."lease_generation", NEW."catalog_epoch", NEW."source_copy_role",
      NEW."source_activation_generation", NEW."source_lifecycle_revision",
      NEW."expected_manifest_sha256", NEW."key_bundle_generation_id",
      NEW."source_authority_canonical", NEW."source_authority_sha256", NEW."object_count",
      NEW."lease_expires_at");
    SELECT cleanup."state" INTO cleanup_state
    FROM "agent_backup_restore_v3_candidate_cleanup_outbox" AS cleanup
    WHERE cleanup."id" = NEW."cleanup_outbox_id"
      AND cleanup."organization_id" = NEW."organization_id"
      AND cleanup."agent_id" = NEW."agent_id"
      AND cleanup."backup_id" = NEW."backup_id"
      AND cleanup."restore_attempt_id" = NEW."restore_attempt_id"
      AND cleanup."operation_id" = NEW."operation_id"
    FOR UPDATE OF cleanup;
    IF NOT FOUND OR cleanup_state NOT IN ('armed', 'held') THEN
      RAISE EXCEPTION 'restore-v3 candidate requires its exact armed cleanup parent'
        USING ERRCODE = '55000';
    END IF;
    IF cleanup_state = 'armed' THEN
      UPDATE "agent_backup_restore_v3_candidate_cleanup_outbox"
      SET "state" = 'held' WHERE "id" = NEW."cleanup_outbox_id";
    END IF;
    IF NEW."lease_expires_at" <= clock_timestamp() THEN
      RAISE EXCEPTION 'restore-v3 candidate lease expired while acquiring its cleanup lock'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW."id", NEW."organization_id", NEW."agent_id", NEW."backup_id",
      NEW."restore_attempt_id", NEW."operation_id", NEW."restore_operation_id",
      NEW."lease_id", NEW."lease_owner_id", NEW."lease_generation", NEW."lease_expires_at",
      NEW."catalog_epoch", NEW."source_copy_role", NEW."source_activation_generation",
      NEW."source_lifecycle_revision", NEW."expected_manifest_sha256",
      NEW."key_bundle_generation_id", NEW."source_authority_canonical",
      NEW."source_authority_sha256", NEW."object_count", NEW."cleanup_outbox_id",
      NEW."execution_token_sha256", NEW."created_at") IS DISTINCT FROM
    ROW(OLD."id", OLD."organization_id", OLD."agent_id", OLD."backup_id",
      OLD."restore_attempt_id", OLD."operation_id", OLD."restore_operation_id",
      OLD."lease_id", OLD."lease_owner_id", OLD."lease_generation", OLD."lease_expires_at",
      OLD."catalog_epoch", OLD."source_copy_role", OLD."source_activation_generation",
      OLD."source_lifecycle_revision", OLD."expected_manifest_sha256",
      OLD."key_bundle_generation_id", OLD."source_authority_canonical",
      OLD."source_authority_sha256", OLD."object_count", OLD."cleanup_outbox_id",
      OLD."execution_token_sha256", OLD."created_at") THEN
    RAISE EXCEPTION 'restore-v3 candidate identity is immutable: %', OLD."id"
      USING ERRCODE = '55000';
  END IF;
  IF OLD."state" IN ('sealed', 'aborted') THEN
    IF NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'restore-v3 candidate is terminal in state %: %', OLD."state", OLD."id"
        USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW."state" = 'active' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN OLD;
  END IF;
  IF pg_trigger_depth() < 2
    OR current_setting('eliza.restore_v3_terminal_candidate', true) <> OLD."id"::text
    OR NEW."state" NOT IN ('sealed', 'aborted') THEN
    RAISE EXCEPTION 'restore-v3 candidate terminal state requires its append-only command: %',
      OLD."id" USING ERRCODE = '55000';
  END IF;
  IF NEW."state" = 'sealed' THEN
    NEW."sealed_at" := statement_timestamp();
    NEW."retention_until" := statement_timestamp() + INTERVAL '30 days';
  ELSE
    NEW."aborted_at" := statement_timestamp();
    NEW."retention_until" := statement_timestamp() + INTERVAL '30 days';
    UPDATE "agent_backup_restore_v3_candidate_cleanup_outbox"
    SET "state" = 'pending',
      "next_attempt_at" = GREATEST("next_attempt_at", statement_timestamp())
    WHERE "id" = OLD."cleanup_outbox_id" AND "state" = 'held';
  END IF;
  NEW."updated_at" := statement_timestamp();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "guard_agent_backup_restore_v3_stage_ledger_insert"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  candidate_state text;
  prior_finished integer;
  record_count integer;
  record_bytes numeric;
  previous_entry_path text;
  previous_entry_file_size_bytes numeric;
  previous_entry_mode integer;
  previous_entry_mtime_ms numeric;
  previous_entry_end_bytes numeric;
BEGIN
  SELECT candidate."state" INTO candidate_state
  FROM "agent_backup_restore_v3_candidates" AS candidate
  WHERE candidate."id" = NEW."candidate_id"
    AND candidate."organization_id" = NEW."organization_id"
    AND candidate."agent_id" = NEW."agent_id"
    AND candidate."backup_id" = NEW."backup_id"
    AND candidate."restore_attempt_id" = NEW."restore_attempt_id"
    AND candidate."operation_id" = NEW."operation_id"
    AND candidate."execution_token_sha256" = NEW."execution_token_sha256"
  FOR UPDATE OF candidate;
  IF NOT FOUND OR candidate_state <> 'active' THEN
    RAISE EXCEPTION 'restore-v3 stage command requires its exact active execution'
      USING ERRCODE = '55000';
  END IF;
  SELECT count(*)::integer INTO prior_finished
  FROM "agent_backup_restore_v3_candidate_stage_ledger"
  WHERE "candidate_id" = NEW."candidate_id" AND "command_kind" = 'finish'
    AND "component_index" < NEW."component_index";
  IF prior_finished <> NEW."component_index" THEN
    RAISE EXCEPTION 'restore-v3 stage components must finish in exact contract order'
      USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "agent_backup_restore_v3_candidate_stage_ledger"
    WHERE "candidate_id" = NEW."candidate_id" AND "command_kind" = 'finish'
      AND "component_index" = NEW."component_index"
  ) THEN
    RAISE EXCEPTION 'restore-v3 stage component is already finished'
      USING ERRCODE = '55000';
  END IF;
  SELECT count(*)::integer, COALESCE(sum("payload_bytes"), 0)
  INTO record_count, record_bytes
  FROM "agent_backup_restore_v3_candidate_stage_ledger"
  WHERE "candidate_id" = NEW."candidate_id" AND "command_kind" = 'record'
    AND "component_index" = NEW."component_index";
  IF NEW."command_kind" = 'record' THEN
    IF NEW."data_index" <> record_count OR NEW."offset_bytes" <> record_bytes THEN
      RAISE EXCEPTION 'restore-v3 stage record must append at the exact durable offset'
        USING ERRCODE = '55000';
    END IF;
    IF NEW."component_name" IN ('media', 'state-files', 'vault') THEN
      SELECT ledger."entry_path", ledger."entry_file_size_bytes", ledger."entry_mode",
        ledger."entry_mtime_ms", ledger."entry_file_offset_bytes" + ledger."payload_bytes"
      INTO previous_entry_path, previous_entry_file_size_bytes, previous_entry_mode,
        previous_entry_mtime_ms, previous_entry_end_bytes
      FROM "agent_backup_restore_v3_candidate_stage_ledger" AS ledger
      WHERE ledger."candidate_id" = NEW."candidate_id"
        AND ledger."command_kind" = 'record'
        AND ledger."component_index" = NEW."component_index"
      ORDER BY ledger."data_index" DESC
      LIMIT 1;

      IF previous_entry_path IS NULL THEN
        IF NEW."entry_file_offset_bytes" <> 0 THEN
          RAISE EXCEPTION 'restore-v3 file-set must begin at offset zero'
            USING ERRCODE = '55000';
        END IF;
      ELSIF NEW."entry_path" = previous_entry_path THEN
        IF NEW."entry_file_size_bytes" <> previous_entry_file_size_bytes
          OR NEW."entry_mode" <> previous_entry_mode
          OR NEW."entry_mtime_ms" <> previous_entry_mtime_ms
          OR NEW."entry_file_offset_bytes" <> previous_entry_end_bytes THEN
          RAISE EXCEPTION 'restore-v3 file metadata or offset changed within one file'
            USING ERRCODE = '55000';
        END IF;
      ELSE
        IF previous_entry_end_bytes <> previous_entry_file_size_bytes THEN
          RAISE EXCEPTION 'restore-v3 file ended before its declared size'
            USING ERRCODE = '55000';
        END IF;
        IF convert_to(NEW."entry_path", 'UTF8') <= convert_to(previous_entry_path, 'UTF8') THEN
          RAISE EXCEPTION 'restore-v3 file paths must be unique and byte ordered'
            USING ERRCODE = '55000';
        END IF;
        IF NEW."entry_file_offset_bytes" <> 0 THEN
          RAISE EXCEPTION 'restore-v3 new file must begin at offset zero'
            USING ERRCODE = '55000';
        END IF;
      END IF;

      IF NEW."payload_bytes" > NEW."entry_file_size_bytes" - NEW."entry_file_offset_bytes" THEN
        RAISE EXCEPTION 'restore-v3 file record exceeds its declared size'
          USING ERRCODE = '55000';
      END IF;
      IF NEW."payload_bytes" = 0 AND NOT (
          NEW."entry_file_size_bytes" = 0
          AND NEW."entry_file_offset_bytes" = 0
          AND previous_entry_path IS DISTINCT FROM NEW."entry_path") THEN
        RAISE EXCEPTION 'restore-v3 file record made no canonical progress'
          USING ERRCODE = '55000';
      END IF;
    END IF;
  ELSIF NEW."command_kind" = 'finish' THEN
    IF NEW."data_frame_count" <> record_count OR NEW."payload_bytes" <> record_bytes THEN
      RAISE EXCEPTION 'restore-v3 finish metadata differs from its durable record ledger'
        USING ERRCODE = '55000';
    END IF;
    IF NEW."component_name" IN ('media', 'state-files', 'vault') AND record_count > 0 THEN
      SELECT ledger."entry_file_size_bytes",
        ledger."entry_file_offset_bytes" + ledger."payload_bytes"
      INTO previous_entry_file_size_bytes, previous_entry_end_bytes
      FROM "agent_backup_restore_v3_candidate_stage_ledger" AS ledger
      WHERE ledger."candidate_id" = NEW."candidate_id"
        AND ledger."command_kind" = 'record'
        AND ledger."component_index" = NEW."component_index"
      ORDER BY ledger."data_index" DESC
      LIMIT 1;
      IF previous_entry_end_bytes <> previous_entry_file_size_bytes THEN
        RAISE EXCEPTION 'restore-v3 final file ended before its declared size'
          USING ERRCODE = '55000';
      END IF;
    END IF;
  ELSE
    RAISE EXCEPTION 'unknown restore-v3 stage command kind' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "reject_agent_backup_restore_v3_stage_ledger_mutation"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1
    AND current_setting('eliza.restore_v3_gc_candidate_id', true) = OLD."candidate_id"::text THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'restore-v3 stage commands are immutable: %', OLD."id"
    USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "guard_agent_backup_restore_v3_seal_authorization"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  candidate agent_backup_restore_v3_candidates%ROWTYPE;
  current_lease_expires_at timestamptz;
  finished_components integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1
      AND current_setting('eliza.restore_v3_gc_candidate_id', true) = OLD."candidate_id"::text
      AND OLD."state" IN ('consumed', 'revoked') THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'restore-v3 seal authorization cannot be deleted: %', OLD."id"
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."state" <> 'active' OR NEW."expires_at" <= clock_timestamp() THEN
      RAISE EXCEPTION 'restore-v3 seal authorization must enter active and unexpired'
        USING ERRCODE = '55000';
    END IF;
    SELECT * INTO candidate FROM "agent_backup_restore_v3_candidates"
    WHERE "id" = NEW."candidate_id";
    IF NOT FOUND THEN
      RAISE EXCEPTION 'restore-v3 seal authorization candidate is missing'
        USING ERRCODE = '55000';
    END IF;
    current_lease_expires_at := "lock_agent_backup_restore_v3_current_authority"(
      candidate."organization_id", candidate."agent_id", candidate."backup_id",
      candidate."restore_attempt_id", candidate."operation_id",
      candidate."restore_operation_id", candidate."lease_id", candidate."lease_owner_id",
      candidate."lease_generation", candidate."catalog_epoch", candidate."source_copy_role",
      candidate."source_activation_generation", candidate."source_lifecycle_revision",
      candidate."expected_manifest_sha256", candidate."key_bundle_generation_id",
      candidate."source_authority_canonical", candidate."source_authority_sha256",
      candidate."object_count", NULL);
    SELECT * INTO candidate FROM "agent_backup_restore_v3_candidates"
    WHERE "id" = NEW."candidate_id"
      AND "organization_id" = NEW."organization_id"
      AND "agent_id" = NEW."agent_id"
      AND "backup_id" = NEW."backup_id"
      AND "restore_attempt_id" = NEW."restore_attempt_id"
      AND "operation_id" = NEW."operation_id"
      AND "execution_token_sha256" = NEW."execution_token_sha256"
    FOR UPDATE;
    IF NOT FOUND OR candidate."state" <> 'active'
      OR NEW."expires_at" <= clock_timestamp()
      OR NEW."expires_at" > current_lease_expires_at THEN
      RAISE EXCEPTION 'restore-v3 seal authorization lacks current candidate authority'
        USING ERRCODE = '55000';
    END IF;
    SELECT count(*)::integer INTO finished_components
    FROM "agent_backup_restore_v3_candidate_stage_ledger"
    WHERE "candidate_id" = NEW."candidate_id" AND "command_kind" = 'finish';
    IF finished_components <> 5 THEN
      RAISE EXCEPTION 'restore-v3 seal authorization requires five finished components'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW."id", NEW."candidate_id", NEW."organization_id", NEW."agent_id",
      NEW."backup_id", NEW."restore_attempt_id", NEW."operation_id",
      NEW."execution_token_sha256", NEW."expected_manifest_sha256",
      NEW."key_bundle_generation_id", NEW."source_copy_role", NEW."source_authority_sha256",
      NEW."object_count", NEW."candidate_receipt_sha256",
      NEW."authorization_request_sha256", NEW."proof_token_sha256", NEW."expires_at",
      NEW."created_at") IS DISTINCT FROM
    ROW(OLD."id", OLD."candidate_id", OLD."organization_id", OLD."agent_id",
      OLD."backup_id", OLD."restore_attempt_id", OLD."operation_id",
      OLD."execution_token_sha256", OLD."expected_manifest_sha256",
      OLD."key_bundle_generation_id", OLD."source_copy_role", OLD."source_authority_sha256",
      OLD."object_count", OLD."candidate_receipt_sha256",
      OLD."authorization_request_sha256", OLD."proof_token_sha256", OLD."expires_at",
      OLD."created_at") THEN
    RAISE EXCEPTION 'restore-v3 seal authorization identity is immutable: %', OLD."id"
      USING ERRCODE = '55000';
  END IF;
  IF OLD."state" IN ('consumed', 'revoked') THEN
    IF NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'restore-v3 seal authorization is terminal: %', OLD."id"
        USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;
  IF pg_trigger_depth() < 2
    OR current_setting('eliza.restore_v3_terminal_candidate', true) <> OLD."candidate_id"::text
    OR NEW."state" NOT IN ('consumed', 'revoked') THEN
    RAISE EXCEPTION 'restore-v3 seal authorization terminal state requires its command: %',
      OLD."id" USING ERRCODE = '55000';
  END IF;
  IF NEW."state" = 'consumed' THEN
    IF OLD."expires_at" <= clock_timestamp() THEN
      RAISE EXCEPTION 'expired restore-v3 seal authorization cannot be consumed: %', OLD."id"
        USING ERRCODE = '55000';
    END IF;
    NEW."consumed_at" := statement_timestamp();
  ELSE
    NEW."revoked_at" := statement_timestamp();
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "validate_agent_backup_restore_v3_candidate_receipt"(
  p_candidate_id uuid,
  p_canonical text,
  p_sha256 text
) RETURNS TABLE(staged_payload_bytes bigint, staged_data_record_count integer)
LANGUAGE plpgsql AS $$
DECLARE
  candidate agent_backup_restore_v3_candidates%ROWTYPE;
  receipt jsonb;
  component jsonb;
  descriptor jsonb;
  source_object jsonb;
  component_ordinal bigint;
  source_ordinal bigint;
  finish_record agent_backup_restore_v3_candidate_stage_ledger%ROWTYPE;
  expected_name text;
  source_object_id uuid;
  source_component_index integer;
  source_chunk_index integer;
  previous_component_index integer := -1;
  previous_chunk_index integer := -1;
  seen_object_ids uuid[] := ARRAY[]::uuid[];
  source_count integer := 0;
  total_payload bigint := 0;
  total_records integer := 0;
BEGIN
  SELECT * INTO candidate FROM "agent_backup_restore_v3_candidates"
  WHERE "id" = p_candidate_id;
  IF NOT FOUND
    OR octet_length(p_canonical) NOT BETWEEN 2 AND 16777216
    OR p_sha256 !~ '^[0-9a-f]{64}$'
    OR "agent_backup_restore_v3_sha256_text"(p_canonical) <> p_sha256 THEN
    RAISE EXCEPTION 'restore-v3 sealed receipt digest is not byte-exact'
      USING ERRCODE = '55000';
  END IF;
  BEGIN
    receipt := p_canonical::jsonb;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'restore-v3 sealed receipt is not valid JSON'
      USING ERRCODE = '55000';
  END;
  IF jsonb_typeof(receipt) <> 'object'
    OR NOT (receipt ?& ARRAY[
      'format', 'restoreAttemptId', 'operationId', 'expectedManifestSha256',
      'keyBundleGenerationId', 'sourceCopyRole', 'sourceAuthorityDerivation',
      'sourceAuthoritySha256', 'objectCount', 'stagedPayloadBytes',
      'stagedDataRecordCount', 'sourceObjects', 'components', 'authorityRevalidated'])
    OR (receipt - ARRAY[
      'format', 'restoreAttemptId', 'operationId', 'expectedManifestSha256',
      'keyBundleGenerationId', 'sourceCopyRole', 'sourceAuthorityDerivation',
      'sourceAuthoritySha256', 'objectCount', 'stagedPayloadBytes',
      'stagedDataRecordCount', 'sourceObjects', 'components', 'authorityRevalidated']) <> '{}'::jsonb
    OR jsonb_typeof(receipt->'format') <> 'string'
    OR jsonb_typeof(receipt->'restoreAttemptId') <> 'string'
    OR jsonb_typeof(receipt->'operationId') <> 'string'
    OR jsonb_typeof(receipt->'expectedManifestSha256') <> 'string'
    OR jsonb_typeof(receipt->'keyBundleGenerationId') <> 'string'
    OR jsonb_typeof(receipt->'sourceCopyRole') <> 'string'
    OR jsonb_typeof(receipt->'sourceAuthorityDerivation') <> 'string'
    OR jsonb_typeof(receipt->'sourceAuthoritySha256') <> 'string'
    OR jsonb_typeof(receipt->'objectCount') <> 'number'
    OR jsonb_typeof(receipt->'stagedPayloadBytes') <> 'number'
    OR jsonb_typeof(receipt->'stagedDataRecordCount') <> 'number'
    OR jsonb_typeof(receipt->'authorityRevalidated') <> 'boolean'
    OR receipt->>'format' <> 'elizaos.agent-backup.restore-v3-stream-candidate.v1'
    OR receipt->>'restoreAttemptId' <> candidate."restore_attempt_id"::text
    OR receipt->>'operationId' <> candidate."operation_id"::text
    OR receipt->>'expectedManifestSha256' <> candidate."expected_manifest_sha256"
    OR receipt->>'keyBundleGenerationId' <> candidate."key_bundle_generation_id"::text
    OR receipt->>'sourceCopyRole' <> candidate."source_copy_role"
    OR receipt->>'sourceAuthorityDerivation'
      <> 'elizaos.agent-backup.restore-v3-source-authority.v1'
    OR receipt->>'sourceAuthoritySha256' <> candidate."source_authority_sha256"
    OR receipt->>'objectCount' <> candidate."object_count"::text
    OR receipt->'authorityRevalidated' <> 'true'::jsonb
    OR jsonb_typeof(receipt->'sourceObjects') <> 'array'
    OR jsonb_typeof(receipt->'components') <> 'array'
    OR jsonb_array_length(receipt->'sourceObjects') <> candidate."object_count"
    OR jsonb_array_length(receipt->'components') <> 5
    OR (receipt->>'stagedPayloadBytes') !~ '^(0|[1-9][0-9]*)$'
    OR (receipt->>'stagedPayloadBytes')::numeric > 1073741824
    OR (receipt->>'stagedDataRecordCount') !~ '^(0|[1-9][0-9]*)$'
    OR (receipt->>'stagedDataRecordCount')::numeric > 16384 THEN
    RAISE EXCEPTION 'restore-v3 sealed receipt top-level binding is invalid'
      USING ERRCODE = '55000';
  END IF;

  FOR component, component_ordinal IN
    SELECT value, ordinality
    FROM jsonb_array_elements(receipt->'components') WITH ORDINALITY
    ORDER BY ordinality
  LOOP
    expected_name := CASE component_ordinal
      WHEN 1 THEN 'character' WHEN 2 THEN 'database' WHEN 3 THEN 'media'
      WHEN 4 THEN 'state-files' WHEN 5 THEN 'vault' ELSE NULL END;
    descriptor := component->'descriptor';
    IF jsonb_typeof(component) <> 'object'
      OR NOT (component ?& ARRAY[
        'componentIndex', 'componentName', 'descriptor', 'dataFrameCount',
        'payloadBytes', 'payloadSha256', 'recordStreamContentHmacSha256'])
      OR (component - ARRAY[
        'componentIndex', 'componentName', 'descriptor', 'dataFrameCount',
        'payloadBytes', 'payloadSha256', 'recordStreamContentHmacSha256']) <> '{}'::jsonb
      OR jsonb_typeof(component->'componentIndex') <> 'number'
      OR jsonb_typeof(component->'componentName') <> 'string'
      OR jsonb_typeof(component->'dataFrameCount') <> 'number'
      OR jsonb_typeof(component->'payloadBytes') <> 'number'
      OR jsonb_typeof(component->'payloadSha256') <> 'string'
      OR jsonb_typeof(component->'recordStreamContentHmacSha256') <> 'string'
      OR component->>'componentIndex' <> (component_ordinal - 1)::text
      OR component->>'componentName' <> expected_name
      OR (component->>'dataFrameCount') !~ '^(0|[1-9][0-9]*)$'
      OR (component->>'payloadBytes') !~ '^(0|[1-9][0-9]*)$'
      OR (component->>'payloadSha256') !~ '^[0-9a-f]{64}$'
      OR (component->>'recordStreamContentHmacSha256') !~ '^[0-9a-f]{64}$'
      OR jsonb_typeof(descriptor) <> 'object'
      OR NOT (descriptor ?& ARRAY['name', 'format', 'compression', 'contentKind', 'consistency'])
      OR (descriptor - ARRAY['name', 'format', 'compression', 'contentKind', 'consistency'])
        <> '{}'::jsonb
      OR jsonb_typeof(descriptor->'name') <> 'string'
      OR jsonb_typeof(descriptor->'format') <> 'string'
      OR jsonb_typeof(descriptor->'compression') <> 'string'
      OR jsonb_typeof(descriptor->'contentKind') <> 'string'
      OR jsonb_typeof(descriptor->'consistency') <> 'string'
      OR descriptor->>'name' <> expected_name THEN
      RAISE EXCEPTION 'restore-v3 sealed component receipt is structurally invalid'
        USING ERRCODE = '55000';
    END IF;
    SELECT * INTO finish_record
    FROM "agent_backup_restore_v3_candidate_stage_ledger"
    WHERE "candidate_id" = p_candidate_id
      AND "command_kind" = 'finish'
      AND "component_index" = component_ordinal - 1;
    IF NOT FOUND
      OR finish_record."component_name" <> expected_name
      OR component->>'dataFrameCount' <> finish_record."data_frame_count"::text
      OR component->>'payloadBytes' <> finish_record."payload_bytes"::text
      OR component->>'payloadSha256' <> finish_record."payload_sha256"
      OR component->>'recordStreamContentHmacSha256'
        <> finish_record."record_stream_content_hmac_sha256"
      OR descriptor->>'format' <> finish_record."descriptor_format"
      OR descriptor->>'compression' <> finish_record."descriptor_compression"
      OR descriptor->>'contentKind' <> finish_record."descriptor_content_kind"
      OR descriptor->>'consistency' <> finish_record."descriptor_consistency" THEN
      RAISE EXCEPTION 'restore-v3 sealed component receipt differs from durable finish metadata'
        USING ERRCODE = '55000';
    END IF;
    total_payload := total_payload + finish_record."payload_bytes";
    total_records := total_records + finish_record."data_frame_count";
  END LOOP;

  FOR source_object, source_ordinal IN
    SELECT value, ordinality
    FROM jsonb_array_elements(receipt->'sourceObjects') WITH ORDINALITY
    ORDER BY ordinality
  LOOP
    source_count := source_count + 1;
    IF jsonb_typeof(source_object) <> 'object'
      OR NOT (source_object ?& ARRAY[
        'componentIndex', 'componentName', 'chunkIndex', 'copyRole', 'objectId',
        'exactReadReceiptDerivation', 'exactReadReceiptSha256',
        'ciphertextSha256', 'sizeBytes'])
      OR (source_object - ARRAY[
        'componentIndex', 'componentName', 'chunkIndex', 'copyRole', 'objectId',
        'exactReadReceiptDerivation', 'exactReadReceiptSha256',
        'ciphertextSha256', 'sizeBytes']) <> '{}'::jsonb
      OR jsonb_typeof(source_object->'componentIndex') <> 'number'
      OR jsonb_typeof(source_object->'componentName') <> 'string'
      OR jsonb_typeof(source_object->'chunkIndex') <> 'number'
      OR jsonb_typeof(source_object->'copyRole') <> 'string'
      OR jsonb_typeof(source_object->'objectId') <> 'string'
      OR jsonb_typeof(source_object->'exactReadReceiptDerivation') <> 'string'
      OR jsonb_typeof(source_object->'exactReadReceiptSha256') <> 'string'
      OR jsonb_typeof(source_object->'ciphertextSha256') <> 'string'
      OR jsonb_typeof(source_object->'sizeBytes') <> 'number'
      OR (source_object->>'componentIndex') !~ '^(0|[1-4])$'
      OR (source_object->>'chunkIndex') !~ '^(0|[1-9][0-9]*)$'
      OR source_object->>'copyRole' <> candidate."source_copy_role"
      OR source_object->>'exactReadReceiptDerivation'
        <> 'elizaos.agent-backup.restore-v3-exact-read-receipt.v1'
      OR (source_object->>'objectId') !~
        '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      OR (source_object->>'exactReadReceiptSha256') !~ '^[0-9a-f]{64}$'
      OR (source_object->>'ciphertextSha256') !~ '^[0-9a-f]{64}$'
      OR (source_object->>'sizeBytes') !~ '^[1-9][0-9]*$' THEN
      RAISE EXCEPTION 'restore-v3 sealed source receipt is structurally invalid'
        USING ERRCODE = '55000';
    END IF;
    BEGIN
      source_object_id := (source_object->>'objectId')::uuid;
      source_component_index := (source_object->>'componentIndex')::integer;
      source_chunk_index := (source_object->>'chunkIndex')::integer;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'restore-v3 sealed source receipt has a non-canonical scalar'
        USING ERRCODE = '55000';
    END;
    expected_name := CASE source_component_index
      WHEN 0 THEN 'character' WHEN 1 THEN 'database' WHEN 2 THEN 'media'
      WHEN 3 THEN 'state-files' WHEN 4 THEN 'vault' ELSE NULL END;
    IF source_object->>'componentName' <> expected_name
      OR source_chunk_index NOT BETWEEN 0 AND 4095
      OR (source_object->>'sizeBytes')::numeric > 17825820
      OR source_component_index < previous_component_index
      OR (source_component_index = previous_component_index
        AND source_chunk_index <> previous_chunk_index + 1)
      OR (source_component_index > previous_component_index
        AND (source_component_index <> previous_component_index + 1
          OR source_chunk_index <> 0))
      OR source_object_id = ANY(seen_object_ids) THEN
      RAISE EXCEPTION 'restore-v3 sealed source receipts are not exact and contiguous'
        USING ERRCODE = '55000';
    END IF;
    seen_object_ids := array_append(seen_object_ids, source_object_id);
    previous_component_index := source_component_index;
    previous_chunk_index := source_chunk_index;
    PERFORM 1 FROM "agent_backup_objects" AS object
    WHERE object."id" = source_object_id
      AND object."organization_id" = candidate."organization_id"
      AND object."backup_id" = candidate."backup_id"
      AND object."copy_role" = candidate."source_copy_role"
      AND object."component" = expected_name
      AND object."chunk_index" = source_chunk_index
      AND object."state" = 'verified'
      AND object."ciphertext_sha256" = source_object->>'ciphertextSha256'
      AND object."size_bytes" = (source_object->>'sizeBytes')::bigint;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'restore-v3 sealed source receipt differs from current object authority'
        USING ERRCODE = '55000';
    END IF;
  END LOOP;
  IF source_count <> candidate."object_count" OR previous_component_index <> 4
    OR total_payload::text <> receipt->>'stagedPayloadBytes'
    OR total_records::text <> receipt->>'stagedDataRecordCount' THEN
    RAISE EXCEPTION 'restore-v3 sealed receipt aggregate differs from its durable ledger'
      USING ERRCODE = '55000';
  END IF;
  staged_payload_bytes := total_payload;
  staged_data_record_count := total_records;
  RETURN NEXT;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "guard_agent_backup_restore_v3_terminal_command"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  candidate agent_backup_restore_v3_candidates%ROWTYPE;
  seal_authorization agent_backup_restore_v3_candidate_seal_authorizations%ROWTYPE;
  receipt_aggregate record;
  current_lease_expires_at timestamptz;
BEGIN
  SELECT * INTO candidate FROM "agent_backup_restore_v3_candidates"
  WHERE "id" = NEW."candidate_id";
  IF NOT FOUND
    OR candidate."organization_id" <> NEW."organization_id"
    OR candidate."agent_id" <> NEW."agent_id"
    OR candidate."backup_id" <> NEW."backup_id"
    OR candidate."restore_attempt_id" <> NEW."restore_attempt_id"
    OR candidate."operation_id" <> NEW."operation_id"
    OR candidate."execution_token_sha256" <> NEW."execution_token_sha256" THEN
    RAISE EXCEPTION 'restore-v3 terminal command differs from its exact execution'
      USING ERRCODE = '55000';
  END IF;
  IF NEW."command_kind" = 'seal' THEN
    current_lease_expires_at := "lock_agent_backup_restore_v3_current_authority"(
      candidate."organization_id", candidate."agent_id", candidate."backup_id",
      candidate."restore_attempt_id", candidate."operation_id",
      candidate."restore_operation_id", candidate."lease_id", candidate."lease_owner_id",
      candidate."lease_generation", candidate."catalog_epoch", candidate."source_copy_role",
      candidate."source_activation_generation", candidate."source_lifecycle_revision",
      candidate."expected_manifest_sha256", candidate."key_bundle_generation_id",
      candidate."source_authority_canonical", candidate."source_authority_sha256",
      candidate."object_count", NULL);
  END IF;
  -- Candidate and proof are deliberately locked only after every external authority.
  SELECT * INTO candidate FROM "agent_backup_restore_v3_candidates"
  WHERE "id" = NEW."candidate_id" AND "execution_token_sha256" = NEW."execution_token_sha256"
  FOR UPDATE;
  IF NOT FOUND OR candidate."state" <> 'active' THEN
    RAISE EXCEPTION 'restore-v3 terminal command requires its exact active candidate'
      USING ERRCODE = '55000';
  END IF;
  PERFORM set_config('eliza.restore_v3_terminal_candidate', candidate."id"::text, true);
  IF NEW."command_kind" = 'seal' THEN
    SELECT * INTO seal_authorization
    FROM "agent_backup_restore_v3_candidate_seal_authorizations"
    WHERE "id" = NEW."authorization_id"
      AND "candidate_id" = candidate."id"
      AND "proof_token_sha256" = NEW."proof_token_sha256"
      AND "candidate_receipt_sha256" = NEW."sealed_receipt_sha256"
    FOR UPDATE;
    IF NOT FOUND OR seal_authorization."state" <> 'active'
      OR seal_authorization."expires_at" <= clock_timestamp()
      OR seal_authorization."expires_at" > current_lease_expires_at THEN
      RAISE EXCEPTION 'restore-v3 seal command proof is stale, consumed, or divergent'
        USING ERRCODE = '55000';
    END IF;
    SELECT * INTO receipt_aggregate
    FROM "validate_agent_backup_restore_v3_candidate_receipt"(
      candidate."id", NEW."sealed_receipt_canonical", NEW."sealed_receipt_sha256");
    UPDATE "agent_backup_restore_v3_candidate_seal_authorizations"
    SET "state" = 'consumed' WHERE "id" = seal_authorization."id";
    UPDATE "agent_backup_restore_v3_candidates"
    SET "state" = 'sealed',
      "sealed_receipt_canonical" = NEW."sealed_receipt_canonical",
      "sealed_receipt_sha256" = NEW."sealed_receipt_sha256",
      "sealed_staged_payload_bytes" = receipt_aggregate.staged_payload_bytes,
      "sealed_staged_data_record_count" = receipt_aggregate.staged_data_record_count
    WHERE "id" = candidate."id";
  ELSE
    UPDATE "agent_backup_restore_v3_candidate_seal_authorizations"
    SET "state" = 'revoked', "revocation_reason_sha256" = NEW."abort_reason_sha256"
    WHERE "candidate_id" = candidate."id" AND "state" = 'active';
    UPDATE "agent_backup_restore_v3_candidates"
    SET "state" = 'aborted', "abort_reason_sha256" = NEW."abort_reason_sha256"
    WHERE "id" = candidate."id";
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "reject_agent_backup_restore_v3_terminal_command_mutation"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1
    AND current_setting('eliza.restore_v3_gc_candidate_id', true) = OLD."candidate_id"::text THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'restore-v3 terminal commands are immutable: %', OLD."id"
    USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "guard_agent_backup_restore_v3_gc_tombstone"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  candidate agent_backup_restore_v3_candidates%ROWTYPE;
  cleanup_state text;
  terminal_evidence text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'restore-v3 GC tombstones are permanent'
      USING ERRCODE = '55000';
  END IF;
  IF NEW."state" <> 'armed' OR NEW."completed_at" IS NOT NULL THEN
    RAISE EXCEPTION 'restore-v3 GC tombstone must enter armed'
      USING ERRCODE = '55000';
  END IF;
  PERFORM "lock_agent_backup_restore_v3_attempt"(
    NEW."organization_id", NEW."restore_attempt_id");
  SELECT * INTO candidate FROM "agent_backup_restore_v3_candidates"
  WHERE "id" = NEW."candidate_id" FOR UPDATE;
  IF NOT FOUND OR candidate."state" NOT IN ('sealed', 'aborted')
    OR candidate."organization_id" <> NEW."organization_id"
    OR candidate."agent_id" <> NEW."agent_id"
    OR candidate."backup_id" <> NEW."backup_id"
    OR candidate."restore_attempt_id" <> NEW."restore_attempt_id"
    OR candidate."operation_id" <> NEW."operation_id"
    OR candidate."cleanup_outbox_id" <> NEW."cleanup_outbox_id"
    OR candidate."state" <> NEW."terminal_state"
    OR candidate."retention_until" <> NEW."retention_until"
    OR candidate."retention_until" > statement_timestamp() THEN
    RAISE EXCEPTION 'restore-v3 GC requires one exact terminal candidate past retention'
      USING ERRCODE = '55000';
  END IF;
  terminal_evidence := CASE candidate."state"
    WHEN 'sealed' THEN candidate."sealed_receipt_sha256"
    ELSE candidate."abort_reason_sha256" END;
  IF terminal_evidence <> NEW."terminal_evidence_sha256" THEN
    RAISE EXCEPTION 'restore-v3 GC terminal evidence is divergent'
      USING ERRCODE = '55000';
  END IF;
  SELECT "state" INTO cleanup_state
  FROM "agent_backup_restore_v3_candidate_cleanup_outbox"
  WHERE "id" = candidate."cleanup_outbox_id" FOR UPDATE;
  IF cleanup_state NOT IN ('completed', 'quarantined') THEN
    RAISE EXCEPTION 'restore-v3 GC requires terminal cleanup proof'
      USING ERRCODE = '55000';
  END IF;
  PERFORM set_config('eliza.restore_v3_gc_candidate', candidate."restore_attempt_id"::text, true);
  PERFORM set_config('eliza.restore_v3_gc_candidate_id', candidate."id"::text, true);
  PERFORM set_config('eliza.restore_v3_gc_cleanup', candidate."cleanup_outbox_id"::text, true);
  DELETE FROM "agent_backup_restore_v3_candidate_terminal_commands"
  WHERE "candidate_id" = candidate."id";
  DELETE FROM "agent_backup_restore_v3_candidate_seal_authorizations"
  WHERE "candidate_id" = candidate."id";
  DELETE FROM "agent_backup_restore_v3_candidate_stage_ledger"
  WHERE "candidate_id" = candidate."id";
  DELETE FROM "agent_backup_restore_v3_candidates" WHERE "id" = candidate."id";
  DELETE FROM "agent_backup_restore_v3_candidate_cleanup_outbox"
  WHERE "id" = candidate."cleanup_outbox_id";
  NEW."state" := 'completed';
  NEW."completed_at" := statement_timestamp();
  NEW."created_at" := statement_timestamp();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "reject_agent_backup_restore_v3_gc_tombstone_mutation"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'restore-v3 GC tombstones are permanent: %', OLD."id"
    USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "agent_backup_restore_v3_cleanup_outbox_guard"
  ON "agent_backup_restore_v3_candidate_cleanup_outbox";
--> statement-breakpoint
CREATE TRIGGER "agent_backup_restore_v3_cleanup_outbox_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "agent_backup_restore_v3_candidate_cleanup_outbox"
  FOR EACH ROW EXECUTE FUNCTION "guard_agent_backup_restore_v3_cleanup_outbox"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "agent_backup_restore_v3_candidate_guard"
  ON "agent_backup_restore_v3_candidates";
--> statement-breakpoint
CREATE TRIGGER "agent_backup_restore_v3_candidate_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "agent_backup_restore_v3_candidates"
  FOR EACH ROW EXECUTE FUNCTION "guard_agent_backup_restore_v3_candidate"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "agent_backup_restore_v3_stage_ledger_insert_guard"
  ON "agent_backup_restore_v3_candidate_stage_ledger";
--> statement-breakpoint
CREATE TRIGGER "agent_backup_restore_v3_stage_ledger_insert_guard"
  BEFORE INSERT ON "agent_backup_restore_v3_candidate_stage_ledger"
  FOR EACH ROW EXECUTE FUNCTION "guard_agent_backup_restore_v3_stage_ledger_insert"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "agent_backup_restore_v3_stage_ledger_mutation_guard"
  ON "agent_backup_restore_v3_candidate_stage_ledger";
--> statement-breakpoint
CREATE TRIGGER "agent_backup_restore_v3_stage_ledger_mutation_guard"
  BEFORE UPDATE OR DELETE ON "agent_backup_restore_v3_candidate_stage_ledger"
  FOR EACH ROW EXECUTE FUNCTION "reject_agent_backup_restore_v3_stage_ledger_mutation"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "agent_backup_restore_v3_seal_authorization_guard"
  ON "agent_backup_restore_v3_candidate_seal_authorizations";
--> statement-breakpoint
CREATE TRIGGER "agent_backup_restore_v3_seal_authorization_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "agent_backup_restore_v3_candidate_seal_authorizations"
  FOR EACH ROW EXECUTE FUNCTION "guard_agent_backup_restore_v3_seal_authorization"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "agent_backup_restore_v3_terminal_command_guard"
  ON "agent_backup_restore_v3_candidate_terminal_commands";
--> statement-breakpoint
CREATE TRIGGER "agent_backup_restore_v3_terminal_command_guard"
  BEFORE INSERT ON "agent_backup_restore_v3_candidate_terminal_commands"
  FOR EACH ROW EXECUTE FUNCTION "guard_agent_backup_restore_v3_terminal_command"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "agent_backup_restore_v3_terminal_command_mutation_guard"
  ON "agent_backup_restore_v3_candidate_terminal_commands";
--> statement-breakpoint
CREATE TRIGGER "agent_backup_restore_v3_terminal_command_mutation_guard"
  BEFORE UPDATE OR DELETE ON "agent_backup_restore_v3_candidate_terminal_commands"
  FOR EACH ROW EXECUTE FUNCTION "reject_agent_backup_restore_v3_terminal_command_mutation"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "agent_backup_restore_v3_gc_tombstone_guard"
  ON "agent_backup_restore_v3_candidate_gc_tombstones";
--> statement-breakpoint
CREATE TRIGGER "agent_backup_restore_v3_gc_tombstone_guard"
  BEFORE INSERT ON "agent_backup_restore_v3_candidate_gc_tombstones"
  FOR EACH ROW EXECUTE FUNCTION "guard_agent_backup_restore_v3_gc_tombstone"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "agent_backup_restore_v3_gc_tombstone_mutation_guard"
  ON "agent_backup_restore_v3_candidate_gc_tombstones";
--> statement-breakpoint
CREATE TRIGGER "agent_backup_restore_v3_gc_tombstone_mutation_guard"
  BEFORE UPDATE OR DELETE ON "agent_backup_restore_v3_candidate_gc_tombstones"
  FOR EACH ROW EXECUTE FUNCTION "reject_agent_backup_restore_v3_gc_tombstone_mutation"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "agent_backup_restore_v3_cleanup_outbox_truncate_guard"
  ON "agent_backup_restore_v3_candidate_cleanup_outbox";
--> statement-breakpoint
CREATE TRIGGER "agent_backup_restore_v3_cleanup_outbox_truncate_guard"
  BEFORE TRUNCATE ON "agent_backup_restore_v3_candidate_cleanup_outbox"
  FOR EACH STATEMENT EXECUTE FUNCTION "reject_agent_backup_restore_v3_candidate_truncate"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "agent_backup_restore_v3_candidates_truncate_guard"
  ON "agent_backup_restore_v3_candidates";
--> statement-breakpoint
CREATE TRIGGER "agent_backup_restore_v3_candidates_truncate_guard"
  BEFORE TRUNCATE ON "agent_backup_restore_v3_candidates"
  FOR EACH STATEMENT EXECUTE FUNCTION "reject_agent_backup_restore_v3_candidate_truncate"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "agent_backup_restore_v3_stage_ledger_truncate_guard"
  ON "agent_backup_restore_v3_candidate_stage_ledger";
--> statement-breakpoint
CREATE TRIGGER "agent_backup_restore_v3_stage_ledger_truncate_guard"
  BEFORE TRUNCATE ON "agent_backup_restore_v3_candidate_stage_ledger"
  FOR EACH STATEMENT EXECUTE FUNCTION "reject_agent_backup_restore_v3_candidate_truncate"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "agent_backup_restore_v3_seal_authorizations_truncate_guard"
  ON "agent_backup_restore_v3_candidate_seal_authorizations";
--> statement-breakpoint
CREATE TRIGGER "agent_backup_restore_v3_seal_authorizations_truncate_guard"
  BEFORE TRUNCATE ON "agent_backup_restore_v3_candidate_seal_authorizations"
  FOR EACH STATEMENT EXECUTE FUNCTION "reject_agent_backup_restore_v3_candidate_truncate"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "agent_backup_restore_v3_terminal_commands_truncate_guard"
  ON "agent_backup_restore_v3_candidate_terminal_commands";
--> statement-breakpoint
CREATE TRIGGER "agent_backup_restore_v3_terminal_commands_truncate_guard"
  BEFORE TRUNCATE ON "agent_backup_restore_v3_candidate_terminal_commands"
  FOR EACH STATEMENT EXECUTE FUNCTION "reject_agent_backup_restore_v3_candidate_truncate"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "agent_backup_restore_v3_gc_tombstones_truncate_guard"
  ON "agent_backup_restore_v3_candidate_gc_tombstones";
--> statement-breakpoint
CREATE TRIGGER "agent_backup_restore_v3_gc_tombstones_truncate_guard"
  BEFORE TRUNCATE ON "agent_backup_restore_v3_candidate_gc_tombstones"
  FOR EACH STATEMENT EXECUTE FUNCTION "reject_agent_backup_restore_v3_candidate_truncate"();
