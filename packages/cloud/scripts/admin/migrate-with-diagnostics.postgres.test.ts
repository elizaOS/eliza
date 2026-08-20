/**
 * Exercises the production migration CLI against real PostgreSQL sessions.
 * The suite creates disposable databases to prove ledger fencing, catalog
 * drift rejection, lock contention recovery, and terminal exhaustion.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const { Client } = pg;
const ROOT = path.resolve(import.meta.dir, "../../../..");
const MIGRATOR = path.join(import.meta.dir, "migrate-with-diagnostics.ts");
const PREFLIGHT = path.join(
  import.meta.dir,
  "preflight-job-execution-interruptions.ts",
);
const MIGRATIONS_DIR = path.join(
  ROOT,
  "packages/cloud/shared/src/db/migrations",
);
const JOURNAL_PATH = path.join(MIGRATIONS_DIR, "meta/_journal.json");
const STRIPE_CUSTOMER_MIGRATION_PATH = path.join(
  MIGRATIONS_DIR,
  "0267_stripe_customer_attempts.sql",
);
const ADD_COLUMN_CREATED_AT = 1_785_384_000_000;
const CATALOG_GUARD_CREATED_AT = 1_786_478_400_000;
const HISTORICAL_DRIFT_CREATED_AT = 1_770_518_468_000;
// One deployed snapshot omitted these five backward-timestamp entries. Another
// observed ledger contained 0017 and placed both it and 0081 after 0105; the
// hybrid fixture preserves that shape while the other modes preserve the first.
const PRODUCTION_LEGACY_SKIPPED_CREATED_AT = new Set([
  1_764_259_200_000, 1_771_275_600_000, 1_771_275_601_000, 1_771_275_602_000,
  1_771_275_603_000,
]);
const PRODUCTION_HYBRID_SKIPPED_CREATED_AT = new Set([
  1_771_275_600_000, 1_771_275_601_000, 1_771_275_602_000, 1_771_275_603_000,
]);
const PRODUCTION_LATE_BACKFILL_TAGS = [
  "0017_add_organization_encryption_keys", // gitleaks:allow immutable migration tag, not credential material
  "0081_db_optimization_and_r2_trajectories",
] as const;
const PRODUCTION_UNRECORDED_TAGS = [
  "0063_zippy_joshua_kane",
  "0065_add_device_bus_tables",
  "0066_add_twilio_inbound_calls",
] as const;
const PRODUCTION_BACKFILL_ANCHOR_TAG =
  "0105_managed_domains_cloudflare_provider";
const BASE_URL =
  process.env.MIGRATION_TEST_DATABASE_URL ??
  process.env.TEST_DATABASE_URL ??
  "";
const ENABLED =
  process.env.RUN_REAL_POSTGRES_MIGRATION_TESTS === "1" &&
  BASE_URL.startsWith("postgres");

interface JournalEntry {
  when: number;
  tag: string;
}

interface CommandResult {
  exitCode: number;
  output: string;
}

let admin: pg.Client;
const databases = new Set<string>();

function quotedIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function databaseUrl(name: string): string {
  const url = new URL(BASE_URL);
  url.pathname = `/${name}`;
  return url.toString();
}

async function createDatabase(): Promise<{
  name: string;
  url: string;
  client: pg.Client;
}> {
  const name = `migration_${Date.now()}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  await admin.query(`CREATE DATABASE ${quotedIdentifier(name)}`);
  databases.add(name);
  const client = new Client({ connectionString: databaseUrl(name) });
  await client.connect();
  return { name, url: databaseUrl(name), client };
}

async function journalEntries(): Promise<JournalEntry[]> {
  const journal = JSON.parse(await readFile(JOURNAL_PATH, "utf8")) as {
    entries: JournalEntry[];
  };
  return journal.entries;
}

/**
 * Journal prefix the fixture records as already applied. Everything after this
 * index is what the migrator must report and apply as pending, so the expected
 * pending count tracks the live journal instead of a hardcoded literal that
 * breaks on every new migration.
 */
const CHECKPOINT_PREFIX_LENGTH = 184;

async function expectedPendingBanner(): Promise<string> {
  const total = (await journalEntries()).length;
  return `pending migrations: ${total - CHECKPOINT_PREFIX_LENGTH}`;
}

/**
 * Materializes the dependency-minimal pre-0185 catalog needed by migrations
 * after the recorded ledger prefix. Pending migrations deliberately run
 * against this checkpoint so missing historical dependencies fail in PostgreSQL.
 */
async function seedPreCheckpointSchema(client: pg.Client): Promise<void> {
  await client.query(`
    CREATE TYPE earnings_source AS ENUM (
      'miniapp', 'agent', 'mcp', 'affiliate',
      'app_owner_revenue_share', 'creator_revenue_share'
    );
    CREATE TYPE ledger_entry_type AS ENUM (
      'earning', 'redemption', 'adjustment', 'refund', 'credit_conversion'
    );
    CREATE TABLE jobs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      type text NOT NULL DEFAULT 'checkpoint_fixture',
      status text NOT NULL DEFAULT 'pending',
      data jsonb NOT NULL DEFAULT '{}'::jsonb,
      data_storage text NOT NULL DEFAULT 'inline',
      agent_id text,
      organization_id uuid,
      execution_quiesced_at timestamp with time zone,
      started_at timestamp with time zone,
      completed_at timestamp with time zone,
      created_at timestamp with time zone NOT NULL DEFAULT now(),
      updated_at timestamp with time zone NOT NULL DEFAULT now()
    );
    CREATE TABLE agent_sandboxes (
      id uuid PRIMARY KEY,
      organization_id uuid,
      container_name text,
      replacement_cleanup_container_name text,
      execution_tier text,
      status text,
      pool_status text,
      node_id text,
      sandbox_id text,
      image_digest text,
      bridge_url text,
      health_url text,
      headscale_ip text,
      last_backup_at timestamp with time zone,
      billing_status text NOT NULL DEFAULT 'active',
      last_billed_at timestamp with time zone,
      hourly_rate numeric(10, 4) DEFAULT '0.0200',
      total_billed numeric(10, 2) NOT NULL DEFAULT '0.00',
      shutdown_warning_sent_at timestamp with time zone,
      scheduled_shutdown_at timestamp with time zone,
      environment_revision integer NOT NULL DEFAULT 0,
      deletion_attempt_id uuid,
      deletion_started_at timestamp with time zone,
      bridge_port integer,
      web_ui_port integer,
      last_heartbeat_at timestamp with time zone,
      updated_at timestamp with time zone,
      CONSTRAINT agent_sandboxes_deletion_intent_pair_check CHECK (
        (deletion_attempt_id IS NULL AND deletion_started_at IS NULL)
        OR (
          deletion_attempt_id IS NOT NULL
          AND deletion_started_at IS NOT NULL
        )
      ),
      CONSTRAINT billing_status_check CHECK (
        billing_status IN ('active', 'warning', 'shutdown_pending', 'suspended')
      )
    );
    CREATE TABLE agent_sandbox_backups (
      id uuid PRIMARY KEY,
      sandbox_record_id uuid NOT NULL REFERENCES agent_sandboxes(id) ON DELETE CASCADE,
      snapshot_type text NOT NULL,
      state_data jsonb NOT NULL,
      state_data_storage text NOT NULL DEFAULT 'inline',
      state_data_key text,
      size_bytes bigint,
      backup_kind text NOT NULL DEFAULT 'full',
      parent_backup_id uuid,
      content_hash text,
      verification_status text,
      verified_at timestamp with time zone,
      verification_error text,
      created_at timestamp with time zone NOT NULL DEFAULT now()
    );
    CREATE TABLE users (
      id uuid PRIMARY KEY,
      name text NOT NULL,
      organization_id uuid,
      role text NOT NULL,
      wallet_verified boolean NOT NULL DEFAULT false,
      is_active boolean NOT NULL DEFAULT true
    );
    CREATE TABLE organizations (
      id uuid PRIMARY KEY,
      name text NOT NULL,
      slug text NOT NULL UNIQUE,
      credit_balance numeric(16, 6) NOT NULL DEFAULT '0.000000',
      is_active boolean NOT NULL DEFAULT true,
      stripe_customer_id text,
      billing_email text,
      stripe_payment_method_id text,
      stripe_default_payment_method text,
      auto_top_up_enabled boolean DEFAULT false,
      auto_top_up_amount numeric(10, 2),
      auto_top_up_threshold numeric(10, 2),
      CONSTRAINT credit_balance_non_negative CHECK (credit_balance >= 0)
    );
    CREATE TABLE organization_billing (
      organization_id uuid NOT NULL UNIQUE
        REFERENCES organizations(id) ON DELETE CASCADE,
      stripe_customer_id text,
      billing_email text,
      tax_id_type text,
      tax_id_value text,
      billing_address jsonb,
      stripe_payment_method_id text,
      stripe_default_payment_method text,
      auto_top_up_enabled boolean NOT NULL DEFAULT false,
      auto_top_up_amount numeric(12, 6),
      auto_top_up_threshold numeric(12, 6) DEFAULT '0.000000',
      updated_at timestamp without time zone NOT NULL DEFAULT now()
    );
    CREATE TABLE credit_transactions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      user_id uuid REFERENCES users(id) ON DELETE SET NULL,
      amount numeric(16, 6) NOT NULL,
      type text NOT NULL,
      description text,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      stripe_payment_intent_id text,
      created_at timestamp with time zone NOT NULL DEFAULT now(),
      settled_at timestamp without time zone
    );
    CREATE TABLE redeemable_earnings_ledger (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      entry_type ledger_entry_type NOT NULL,
      amount numeric(18, 4) NOT NULL,
      earnings_source earnings_source,
      source_id uuid,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb
    );
    CREATE TABLE containers (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      status text NOT NULL DEFAULT 'pending',
      image_tag text,
      environment_vars jsonb NOT NULL DEFAULT '{}'::jsonb,
      desired_count integer NOT NULL DEFAULT 1,
      cpu integer NOT NULL DEFAULT 1792,
      memory integer NOT NULL DEFAULT 1792,
      node_id text,
      volume_path text,
      last_billed_at timestamp without time zone,
      total_billed numeric(10, 2) NOT NULL DEFAULT '0.00'
    );
    CREATE TABLE container_billing_records (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      container_id uuid NOT NULL,
      organization_id uuid NOT NULL,
      amount numeric(10, 2) NOT NULL,
      billing_period_start timestamp without time zone NOT NULL,
      billing_period_end timestamp without time zone NOT NULL,
      status text NOT NULL DEFAULT 'success',
      credit_transaction_id uuid,
      error_message text,
      created_at timestamp without time zone NOT NULL DEFAULT now(),
      CONSTRAINT container_billing_records_container_id_containers_id_fk
        FOREIGN KEY (container_id) REFERENCES containers(id) ON DELETE CASCADE,
      CONSTRAINT container_billing_records_organization_id_organizations_id_fk
        FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
      CONSTRAINT container_billing_records_credit_transaction_id_credit_transactions_id_fk
        FOREIGN KEY (credit_transaction_id) REFERENCES credit_transactions(id) ON DELETE SET NULL
    );
    CREATE TABLE credit_packs (
      id uuid PRIMARY KEY
    );
    CREATE TABLE identity_links (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      user_id uuid REFERENCES users(id) ON DELETE SET NULL,
      left_entity_id text NOT NULL,
      right_entity_id text NOT NULL,
      provider text,
      source text NOT NULL DEFAULT 'manual',
      created_at timestamp with time zone NOT NULL DEFAULT now(),
      CONSTRAINT identity_links_source_check CHECK (
        source IN ('oauth', 'manual', 'wallet')
      )
    );
    CREATE TABLE twilio_inbound_calls (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      call_sid text NOT NULL UNIQUE,
      account_sid text NOT NULL,
      from_number text NOT NULL,
      to_number text NOT NULL,
      call_status text NOT NULL,
      agent_id uuid,
      raw_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
      raw_payload_storage text NOT NULL DEFAULT 'inline',
      raw_payload_key text,
      received_at timestamp with time zone NOT NULL DEFAULT now()
    );
    CREATE TABLE docker_nodes (
      id uuid PRIMARY KEY,
      node_id text UNIQUE NOT NULL,
      host_key_fingerprint text,
      updated_at timestamp with time zone NOT NULL DEFAULT now()
    );
    CREATE TABLE payment_requests (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      provider text NOT NULL CHECK (
        provider IN ('stripe', 'oxapay', 'x402', 'wallet_native')
      ),
      amount_cents bigint NOT NULL CHECK (amount_cents >= 0),
      currency text NOT NULL DEFAULT 'usd',
      provider_intent jsonb NOT NULL DEFAULT '{}'::jsonb,
      status text NOT NULL DEFAULT 'pending' CHECK (
        status IN ('pending', 'delivered', 'settled', 'failed', 'expired', 'canceled')
      ),
      settled_at timestamp with time zone,
      settlement_tx_ref text,
      settlement_proof jsonb
    );
    CREATE TABLE payment_request_events (
      id uuid PRIMARY KEY,
      payment_request_id uuid NOT NULL REFERENCES payment_requests(id) ON DELETE CASCADE,
      event_name text NOT NULL CHECK (
        event_name IN (
          'payment.created', 'payment.delivered', 'payment.viewed',
          'payment.proof_received', 'payment.settled', 'payment.failed',
          'payment.canceled', 'payment.expired', 'callback.dispatched',
          'callback.failed', 'webhook.received'
        )
      ),
      redacted_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
      occurred_at timestamp with time zone NOT NULL DEFAULT now()
    );
    CREATE TABLE crypto_payments (
      id uuid PRIMARY KEY,
      transaction_hash text,
      status text NOT NULL DEFAULT 'pending',
      updated_at timestamp with time zone NOT NULL DEFAULT now()
    );
    CREATE TABLE service_pricing (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      service_id text NOT NULL,
      method text NOT NULL,
      cost numeric(12, 6) NOT NULL,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      updated_at timestamp without time zone NOT NULL DEFAULT now()
    );
    CREATE TABLE service_pricing_audit (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      service_pricing_id uuid REFERENCES service_pricing(id) ON DELETE SET NULL,
      service_id text NOT NULL,
      method text NOT NULL,
      old_cost numeric(12, 6),
      new_cost numeric(12, 6) NOT NULL,
      change_type text NOT NULL,
      changed_by text NOT NULL,
      reason text
    );
    CREATE TABLE org_storage_quota (
      organization_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
      bytes_used bigint NOT NULL DEFAULT 0,
      bytes_limit bigint NOT NULL DEFAULT 5368709120,
      created_at timestamp without time zone NOT NULL DEFAULT now(),
      updated_at timestamp without time zone NOT NULL DEFAULT now()
    );
    CREATE TABLE apps (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE
    );
    CREATE TABLE app_earnings_transactions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
      user_id uuid REFERENCES users(id) ON DELETE SET NULL,
      type text NOT NULL,
      amount numeric(10, 6) NOT NULL,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb
    );
    CREATE TABLE managed_domains (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      domain text NOT NULL
    );
    CREATE TABLE domain_purchase_idempotency (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      key text NOT NULL UNIQUE,
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
      domain text NOT NULL,
      status text NOT NULL DEFAULT 'processing',
      charge_id uuid,
      charge jsonb,
      cloudflare_registration_id text,
      managed_domain_id uuid,
      response_body jsonb,
      error_code text,
      expires_at timestamp without time zone NOT NULL,
      created_at timestamp without time zone NOT NULL DEFAULT now(),
      updated_at timestamp without time zone NOT NULL DEFAULT now()
    );
    CREATE SCHEMA drizzle;
    CREATE TABLE drizzle.__drizzle_migrations (
      id serial PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    );
  `);
}

async function seedAppliedPrefix(
  client: pg.Client,
  length: number,
  order: "timestamp" | "journal" | "production-hybrid" = "journal",
): Promise<void> {
  await seedPreCheckpointSchema(client);

  // Deployed historical runners used both orders. Timestamp mode preserves
  // production inversions where a later journal entry ran first; journal mode
  // preserves older installations that recorded backward timestamps in place.
  const skipped =
    order === "production-hybrid"
      ? PRODUCTION_HYBRID_SKIPPED_CREATED_AT
      : PRODUCTION_LEGACY_SKIPPED_CREATED_AT;
  let entries = (await journalEntries())
    .slice(0, length)
    .filter((entry) => !skipped.has(entry.when));
  if (order !== "journal") {
    entries.sort((left, right) => left.when - right.when);
  }
  if (order === "production-hybrid") {
    const lateBackfills = PRODUCTION_LATE_BACKFILL_TAGS.map((tag) => {
      const entry = entries.find((candidate) => candidate.tag === tag);
      if (!entry) throw new Error(`Missing production backfill fixture ${tag}`);
      return entry;
    });
    entries = entries.filter(
      (entry) =>
        !PRODUCTION_LATE_BACKFILL_TAGS.some((tag) => tag === entry.tag),
    );
    const anchorIndex = entries.findIndex(
      (entry) => entry.tag === PRODUCTION_BACKFILL_ANCHOR_TAG,
    );
    if (anchorIndex === -1) {
      throw new Error(
        `Missing production backfill anchor ${PRODUCTION_BACKFILL_ANCHOR_TAG}`,
      );
    }
    entries.splice(anchorIndex + 1, 0, ...lateBackfills);
  }
  for (const entry of entries) {
    const sql = await readFile(
      path.join(MIGRATIONS_DIR, `${entry.tag}.sql`),
      "utf8",
    );
    const hash = createHash("sha256").update(sql).digest("hex");
    await client.query(
      "INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)",
      [hash, entry.when],
    );
  }
}

async function runScript(
  script: string,
  database: string,
  overrides: Record<string, string> = {},
): Promise<CommandResult> {
  const processHandle = Bun.spawn(
    ["bun", "--conditions=eliza-source", script],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        DATABASE_URL: database,
        MIGRATION_LOCK_TIMEOUT_MS: "75",
        MIGRATION_LOCK_MAX_ATTEMPTS: "20",
        MIGRATION_LOCK_RETRY_BASE_MS: "5",
        MIGRATION_LOCK_RETRY_MAX_MS: "20",
        JOB_INTERRUPTION_PREFLIGHT_MAX_ATTEMPTS: "1",
        JOB_INTERRUPTION_PREFLIGHT_DELAY_MS: "1",
        ...overrides,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
    processHandle.exited,
  ]);
  return { exitCode, output: `${stdout}${stderr}` };
}

async function waitForAdvisoryLock(client: pg.Client): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await client.query<{ count: string }>(`
      SELECT count(*)::text AS count
      FROM pg_locks
      WHERE locktype = 'advisory' AND granted
    `);
    if (Number(result.rows[0]?.count) >= 1) return;
    await Bun.sleep(10);
  }
  throw new Error("Timed out waiting for migration advisory lock");
}

async function expectPreCheckpointPaymentRequestAuthority(
  client: pg.Client,
): Promise<void> {
  const authority = await client.query<{
    payment_columns: string[];
    organization_id_type: string;
    organization_id_nullable: string;
    provider_type: string;
    provider_nullable: string;
    organization_fk: string;
    provider_check: string;
    receipt_table: string | null;
    receipt_parent_index: string | null;
  }>(`
    SELECT
      (SELECT to_json(array_agg(format('%s:%s:%s', attname,
          format_type(atttypid, atttypmod),
          CASE WHEN attnotnull THEN 'required' ELSE 'nullable' END)
        ORDER BY attnum))
        FROM pg_attribute
        WHERE attrelid = 'payment_requests'::regclass
          AND attnum > 0 AND NOT attisdropped) AS payment_columns,
      (SELECT data_type FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'payment_requests'
          AND column_name = 'organization_id') AS organization_id_type,
      (SELECT is_nullable FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'payment_requests'
          AND column_name = 'organization_id') AS organization_id_nullable,
      (SELECT data_type FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'payment_requests'
          AND column_name = 'provider') AS provider_type,
      (SELECT is_nullable FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'payment_requests'
          AND column_name = 'provider') AS provider_nullable,
      (SELECT pg_get_constraintdef(oid) FROM pg_constraint
        WHERE conrelid = 'payment_requests'::regclass AND contype = 'f'
          AND conkey = ARRAY[(SELECT attnum FROM pg_attribute
            WHERE attrelid = 'payment_requests'::regclass
              AND attname = 'organization_id')]::smallint[]) AS organization_fk,
      (SELECT pg_get_constraintdef(oid) FROM pg_constraint
        WHERE conrelid = 'payment_requests'::regclass AND contype = 'c'
          AND pg_get_constraintdef(oid) LIKE '%provider%') AS provider_check,
      to_regclass('public.payment_request_receipts')::text AS receipt_table,
      to_regclass('public.payment_requests_id_organization_provider_unique')::text
        AS receipt_parent_index
  `);
  expect(authority.rows[0]).toEqual({
    payment_columns: [
      "id:uuid:required",
      "organization_id:uuid:required",
      "provider:text:required",
      "amount_cents:bigint:required",
      "currency:text:required",
      "provider_intent:jsonb:required",
      "status:text:required",
      "settled_at:timestamp with time zone:nullable",
      "settlement_tx_ref:text:nullable",
      "settlement_proof:jsonb:nullable",
    ],
    organization_id_type: "uuid",
    organization_id_nullable: "NO",
    provider_type: "text",
    provider_nullable: "NO",
    organization_fk:
      "FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE",
    provider_check:
      "CHECK ((provider = ANY (ARRAY['stripe'::text, 'oxapay'::text, 'x402'::text, 'wallet_native'::text])))",
    receipt_table: null,
    receipt_parent_index: null,
  });
}

async function expectPreCheckpointOrganizationBillingAuthority(
  client: pg.Client,
): Promise<void> {
  const authority = await client.query<{
    organization_columns: string[];
    billing_columns: string[];
    organization_fk: string;
    organization_unique: string;
    authority_index: string | null;
    shadow_authority_index: string | null;
    sync_function: string | null;
    shadow_guard: string | null;
  }>(`
    SELECT
      (SELECT to_json(array_agg(format('%s:%s:%s', attname,
          format_type(atttypid, atttypmod),
          CASE WHEN attnotnull THEN 'required' ELSE 'nullable' END)
        ORDER BY attnum))
        FROM pg_attribute
        WHERE attrelid = 'organizations'::regclass
          AND attnum > 0 AND NOT attisdropped AND attname IN (
            'stripe_customer_id', 'billing_email', 'stripe_payment_method_id',
            'stripe_default_payment_method', 'auto_top_up_enabled',
            'auto_top_up_amount', 'auto_top_up_threshold'
          )) AS organization_columns,
      (SELECT to_json(array_agg(format('%s:%s:%s', attname,
          format_type(atttypid, atttypmod),
          CASE WHEN attnotnull THEN 'required' ELSE 'nullable' END)
        ORDER BY attnum))
        FROM pg_attribute
        WHERE attrelid = 'organization_billing'::regclass
          AND attnum > 0 AND NOT attisdropped)
        AS billing_columns,
      (SELECT pg_get_constraintdef(oid) FROM pg_constraint
        WHERE conrelid = 'organization_billing'::regclass AND contype = 'f'
          AND conkey = ARRAY[(SELECT attnum FROM pg_attribute
            WHERE attrelid = 'organization_billing'::regclass
              AND attname = 'organization_id')]::smallint[]) AS organization_fk,
      (SELECT pg_get_constraintdef(oid) FROM pg_constraint
        WHERE conrelid = 'organization_billing'::regclass AND contype = 'u'
          AND conkey = ARRAY[(SELECT attnum FROM pg_attribute
            WHERE attrelid = 'organization_billing'::regclass
              AND attname = 'organization_id')]::smallint[]) AS organization_unique,
      to_regclass('public.organizations_stripe_customer_authority_unique')::text
        AS authority_index,
      to_regclass('public.org_billing_stripe_customer_authority_unique')::text
        AS shadow_authority_index,
      to_regprocedure('public.sync_organization_billing_shadow()')::text AS sync_function,
      to_regprocedure('public.guard_organization_billing_shadow()')::text AS shadow_guard
  `);
  expect(authority.rows[0]).toEqual({
    organization_columns: [
      "stripe_customer_id:text:nullable",
      "billing_email:text:nullable",
      "stripe_payment_method_id:text:nullable",
      "stripe_default_payment_method:text:nullable",
      "auto_top_up_enabled:boolean:nullable",
      "auto_top_up_amount:numeric(10,2):nullable",
      "auto_top_up_threshold:numeric(10,2):nullable",
    ],
    billing_columns: [
      "organization_id:uuid:required",
      "stripe_customer_id:text:nullable",
      "billing_email:text:nullable",
      "tax_id_type:text:nullable",
      "tax_id_value:text:nullable",
      "billing_address:jsonb:nullable",
      "stripe_payment_method_id:text:nullable",
      "stripe_default_payment_method:text:nullable",
      "auto_top_up_enabled:boolean:required",
      "auto_top_up_amount:numeric(12,6):nullable",
      "auto_top_up_threshold:numeric(12,6):nullable",
      "updated_at:timestamp without time zone:required",
    ],
    organization_fk:
      "FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE",
    organization_unique: "UNIQUE (organization_id)",
    authority_index: null,
    shadow_authority_index: null,
    sync_function: null,
    shadow_guard: null,
  });
}

async function expectPreCheckpointComputeBillingAuthority(
  client: pg.Client,
): Promise<void> {
  const authority = await client.query<{
    container_columns: string[];
    receipt_columns: string[];
    jobs_id_type: string;
    last_backup_type: string;
    container_lifecycle_revision: string | null;
    receipt_rate_segments: string | null;
    container_tenant_index: string | null;
    agent_receipts: string | null;
    container_stop_intents: string | null;
    agent_stop_intents: string | null;
    rate_segments: string | null;
  }>(`
    SELECT
      (SELECT array_agg(format('%s:%s:%s:%s', a.attname,
          format_type(a.atttypid, a.atttypmod),
          CASE WHEN a.attnotnull THEN 'required' ELSE 'nullable' END,
          COALESCE(pg_get_expr(d.adbin, d.adrelid), 'none')) ORDER BY a.attnum)
        FROM pg_attribute a
        LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE a.attrelid = 'containers'::regclass
          AND a.attnum > 0 AND NOT a.attisdropped) AS container_columns,
      (SELECT array_agg(format('%s:%s:%s:%s', a.attname,
          format_type(a.atttypid, a.atttypmod),
          CASE WHEN a.attnotnull THEN 'required' ELSE 'nullable' END,
          COALESCE(pg_get_expr(d.adbin, d.adrelid), 'none')) ORDER BY a.attnum)
        FROM pg_attribute a
        LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE a.attrelid = 'container_billing_records'::regclass
          AND a.attnum > 0 AND NOT a.attisdropped) AS receipt_columns,
      (SELECT data_type FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'jobs' AND column_name = 'id')
        AS jobs_id_type,
      (SELECT data_type FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'agent_sandboxes'
          AND column_name = 'last_backup_at') AS last_backup_type,
      (SELECT data_type FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'containers'
          AND column_name = 'lifecycle_revision') AS container_lifecycle_revision,
      (SELECT data_type FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'container_billing_records'
          AND column_name = 'rate_segments') AS receipt_rate_segments,
      to_regclass('public.containers_id_organization_unique')::text AS container_tenant_index,
      to_regclass('public.agent_billing_records')::text AS agent_receipts,
      to_regclass('public.container_compute_stop_intents')::text AS container_stop_intents,
      to_regclass('public.agent_compute_stop_intents')::text AS agent_stop_intents,
      to_regclass('public.compute_billing_rate_segments')::text AS rate_segments
  `);
  expect(authority.rows[0]).toEqual({
    container_columns: [
      "id:uuid:required:gen_random_uuid()",
      "organization_id:uuid:required:none",
      "status:text:required:'pending'::text",
      "image_tag:text:nullable:none",
      "environment_vars:jsonb:required:'{}'::jsonb",
      "desired_count:integer:required:1",
      "cpu:integer:required:1792",
      "memory:integer:required:1792",
      "node_id:text:nullable:none",
      "volume_path:text:nullable:none",
      "last_billed_at:timestamp without time zone:nullable:none",
      "total_billed:numeric(10,2):required:0.00",
    ],
    receipt_columns: [
      "id:uuid:required:gen_random_uuid()",
      "container_id:uuid:required:none",
      "organization_id:uuid:required:none",
      "amount:numeric(10,2):required:none",
      "billing_period_start:timestamp without time zone:required:none",
      "billing_period_end:timestamp without time zone:required:none",
      "status:text:required:'success'::text",
      "credit_transaction_id:uuid:nullable:none",
      "error_message:text:nullable:none",
      "created_at:timestamp without time zone:required:now()",
    ],
    jobs_id_type: "uuid",
    last_backup_type: "timestamp with time zone",
    container_lifecycle_revision: null,
    receipt_rate_segments: null,
    container_tenant_index: null,
    agent_receipts: null,
    container_stop_intents: null,
    agent_stop_intents: null,
    rate_segments: null,
  });
}

async function expectPreCheckpointAppReservationSettlementAuthority(
  client: pg.Client,
): Promise<void> {
  const authority = await client.query<{
    settled_at: string;
    creator_projection_columns: string[];
    app_projection_columns: string[];
    settlement_table: string | null;
    quarantine_table: string | null;
    quarantine_uuid_function: string | null;
    settlement_trigger: string | null;
    creator_user_fk: string;
    app_fk: string;
    app_user_fk: string;
    ledger_entry_type_labels: string[];
    earnings_source_labels: string[];
  }>(`
    SELECT
      (SELECT format('%s:%s:%s', format_type(a.atttypid, a.atttypmod),
          CASE WHEN a.attnotnull THEN 'required' ELSE 'nullable' END,
          COALESCE(pg_get_expr(d.adbin, d.adrelid), 'none'))
        FROM pg_attribute a
        LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE a.attrelid = 'credit_transactions'::regclass
          AND a.attname = 'settled_at' AND NOT a.attisdropped) AS settled_at,
      (SELECT to_json(array_agg(format('%s:%s:%s:%s', a.attname,
          format_type(a.atttypid, a.atttypmod),
          CASE WHEN a.attnotnull THEN 'required' ELSE 'nullable' END,
          COALESCE(pg_get_expr(d.adbin, d.adrelid), 'none'))
        ORDER BY a.attnum))
        FROM pg_attribute a
        LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE a.attrelid = 'redeemable_earnings_ledger'::regclass
          AND a.attnum > 0 AND NOT a.attisdropped) AS creator_projection_columns,
      (SELECT to_json(array_agg(format('%s:%s:%s:%s', a.attname,
          format_type(a.atttypid, a.atttypmod),
          CASE WHEN a.attnotnull THEN 'required' ELSE 'nullable' END,
          COALESCE(pg_get_expr(d.adbin, d.adrelid), 'none'))
        ORDER BY a.attnum))
        FROM pg_attribute a
        LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE a.attrelid = 'app_earnings_transactions'::regclass
          AND a.attnum > 0 AND NOT a.attisdropped) AS app_projection_columns,
      to_regclass('public.app_reservation_settlements')::text AS settlement_table,
      to_regclass('public.app_reservation_settlement_quarantines')::text
        AS quarantine_table,
      to_regprocedure('public.app_reservation_quarantine_uuid(text)')::text
        AS quarantine_uuid_function,
      (SELECT tgname FROM pg_trigger
        WHERE tgrelid = 'credit_transactions'::regclass
          AND tgname = 'credit_transactions_legacy_app_settlement_quarantine_guard'
          AND NOT tgisinternal) AS settlement_trigger,
      (SELECT pg_get_constraintdef(oid) FROM pg_constraint
        WHERE conrelid = 'redeemable_earnings_ledger'::regclass
          AND contype = 'f') AS creator_user_fk,
      (SELECT pg_get_constraintdef(oid) FROM pg_constraint
        WHERE conrelid = 'app_earnings_transactions'::regclass
          AND contype = 'f' AND conkey = ARRAY[(SELECT attnum FROM pg_attribute
            WHERE attrelid = 'app_earnings_transactions'::regclass
              AND attname = 'app_id')]::smallint[]) AS app_fk,
      (SELECT pg_get_constraintdef(oid) FROM pg_constraint
        WHERE conrelid = 'app_earnings_transactions'::regclass
          AND contype = 'f' AND conkey = ARRAY[(SELECT attnum FROM pg_attribute
            WHERE attrelid = 'app_earnings_transactions'::regclass
              AND attname = 'user_id')]::smallint[]) AS app_user_fk,
      (SELECT to_json(array_agg(e.enumlabel ORDER BY e.enumsortorder))
        FROM pg_enum e
        WHERE e.enumtypid = 'ledger_entry_type'::regtype) AS ledger_entry_type_labels,
      (SELECT to_json(array_agg(e.enumlabel ORDER BY e.enumsortorder))
        FROM pg_enum e
        WHERE e.enumtypid = 'earnings_source'::regtype) AS earnings_source_labels
  `);
  expect(authority.rows[0]).toEqual({
    settled_at: "timestamp without time zone:nullable:none",
    creator_projection_columns: [
      "id:uuid:required:gen_random_uuid()",
      "user_id:uuid:required:none",
      "entry_type:ledger_entry_type:required:none",
      "amount:numeric(18,4):required:none",
      "earnings_source:earnings_source:nullable:none",
      "source_id:uuid:nullable:none",
      "metadata:jsonb:required:'{}'::jsonb",
    ],
    app_projection_columns: [
      "id:uuid:required:gen_random_uuid()",
      "app_id:uuid:required:none",
      "user_id:uuid:nullable:none",
      "type:text:required:none",
      "amount:numeric(10,6):required:none",
      "metadata:jsonb:required:'{}'::jsonb",
    ],
    settlement_table: null,
    quarantine_table: null,
    quarantine_uuid_function: null,
    settlement_trigger: null,
    creator_user_fk:
      "FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE",
    app_fk: "FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE",
    app_user_fk:
      "FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL",
    ledger_entry_type_labels: [
      "earning",
      "redemption",
      "adjustment",
      "refund",
      "credit_conversion",
    ],
    earnings_source_labels: [
      "miniapp",
      "agent",
      "mcp",
      "affiliate",
      "app_owner_revenue_share",
      "creator_revenue_share",
    ],
  });
}

describe.skipIf(!ENABLED)(
  "migrate-with-diagnostics real PostgreSQL safety",
  () => {
    beforeAll(async () => {
      admin = new Client({ connectionString: BASE_URL });
      await admin.connect();
    });

    afterAll(async () => {
      for (const name of databases) {
        await admin.query(
          `DROP DATABASE IF EXISTS ${quotedIdentifier(name)} WITH (FORCE)`,
        );
      }
      await admin.end();
    }, 300_000);

    test("accepts portable Stripe Customer authority catalogs and rejects semantic drift", async () => {
      const database = await createDatabase();
      await database.client.query(`
        CREATE TABLE organizations (
          id uuid PRIMARY KEY,
          name text NOT NULL,
          slug text NOT NULL UNIQUE,
          stripe_customer_id text,
          billing_email text,
          updated_at timestamp with time zone NOT NULL DEFAULT now()
        );
        CREATE UNIQUE INDEX organizations_stripe_customer_authority_unique
          ON organizations(stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;
        CREATE TABLE auto_top_up_attempts (
          id uuid PRIMARY KEY,
          organization_id uuid NOT NULL REFERENCES organizations(id),
          stripe_customer_id_snapshot text NOT NULL,
          provider_request_started_at timestamp with time zone
        );
      `);
      const migration = await readFile(STRIPE_CUSTOMER_MIGRATION_PATH, "utf8");
      const statements = migration
        .split("--> statement-breakpoint")
        .filter((statement) => statement.trim());
      await database.client.query(migration);
      await database.client.query(migration);

      const catalog = await database.client.query<{
        attempts: string;
        quarantines: string;
      }>(`
        SELECT
          count(*) FILTER (
            WHERE conrelid='stripe_customer_attempts'::regclass AND contype <> 'n'
          )::text AS attempts,
          count(*) FILTER (
            WHERE conrelid='stripe_customer_legacy_quarantines'::regclass AND contype <> 'n'
          )::text AS quarantines
        FROM pg_constraint
      `);
      expect(catalog.rows[0]).toEqual({ attempts: "10", quarantines: "7" });

      const postcondition = statements.at(-1);
      if (!postcondition)
        throw new Error("Migration has no catalog postcondition");
      await database.client.query(`ALTER TABLE stripe_customer_attempts
        ADD CONSTRAINT stripe_customer_attempts_unexpected_check CHECK (generation < 1000000)`);
      await expect(database.client.query(postcondition)).rejects.toThrow(
        /exact constraint collision/i,
      );
      await database.client.query(`ALTER TABLE stripe_customer_attempts
        DROP CONSTRAINT stripe_customer_attempts_unexpected_check`);
      await database.client.query(
        "ALTER TABLE stripe_customer_attempts ALTER COLUMN status DROP NOT NULL",
      );
      await expect(database.client.query(postcondition)).rejects.toThrow(
        /column collision/i,
      );
      await database.client.end();
    }, 120_000);

    test("applies the append-only fix-forward once and passes the reusable catalog preflight", async () => {
      const database = await createDatabase();
      await seedAppliedPrefix(database.client, CHECKPOINT_PREFIX_LENGTH);
      await expectPreCheckpointPaymentRequestAuthority(database.client);
      await expectPreCheckpointOrganizationBillingAuthority(database.client);
      await expectPreCheckpointComputeBillingAuthority(database.client);
      await expectPreCheckpointAppReservationSettlementAuthority(
        database.client,
      );
      await database.client.query(`
        INSERT INTO jobs (
          status,
          execution_quiesced_at,
          started_at,
          created_at,
          updated_at
        ) VALUES (
          'failed',
          '2026-01-02T00:00:00Z',
          '2026-01-01T12:00:00Z',
          '2026-01-01T00:00:00Z',
          '2026-01-03T00:00:00Z'
        )
      `);

      const first = await runScript(MIGRATOR, database.url);
      expect(first.exitCode, first.output).toBe(0);
      expect(first.output).toContain(await expectedPendingBanner());

      const catalog = await database.client.query<{
        data_type: string;
        is_nullable: string;
        column_default: string;
        zeros: string;
        terminal_backfills: string;
      }>(`
      SELECT catalog_column.data_type, catalog_column.is_nullable,
        catalog_column.column_default,
        (SELECT count(*)::text FROM jobs WHERE execution_interruptions = 0) AS zeros,
        (SELECT count(*)::text FROM jobs
          WHERE status = 'failed'
            AND completed_at = execution_quiesced_at) AS terminal_backfills
      FROM information_schema.columns AS catalog_column
      WHERE catalog_column.table_schema = 'public'
        AND catalog_column.table_name = 'jobs'
        AND catalog_column.column_name = 'execution_interruptions'
    `);
      expect(catalog.rows[0]).toEqual({
        data_type: "integer",
        is_nullable: "NO",
        column_default: "0",
        zeros: "1",
        terminal_backfills: "1",
      });

      const placementState = await database.client.query<{
        data_type: string;
        is_nullable: string;
        column_default: string;
      }>(`
        SELECT data_type, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'docker_nodes'
          AND column_name = 'placement_state'
      `);
      expect(placementState.rows[0]).toEqual({
        data_type: "text",
        is_nullable: "NO",
        column_default: "'open'::text",
      });

      const second = await runScript(MIGRATOR, database.url);
      expect(second.exitCode, second.output).toBe(0);
      expect(second.output).toContain("pending migrations: 0");

      const preflight = await runScript(PREFLIGHT, database.url);
      expect(preflight.exitCode, preflight.output).toBe(0);
      expect(preflight.output).toContain("catalog and journal verified");
      await database.client.end();
    }, 30_000);

    test("accepts historical production hash drift but enforces hashes from the checkpoint forward", async () => {
      const database = await createDatabase();
      await seedAppliedPrefix(database.client, CHECKPOINT_PREFIX_LENGTH);
      await database.client.query(
        "UPDATE drizzle.__drizzle_migrations SET hash = 'historical-drift' WHERE created_at = $1",
        [HISTORICAL_DRIFT_CREATED_AT],
      );

      const migrated = await runScript(MIGRATOR, database.url);
      expect(migrated.exitCode, migrated.output).toBe(0);
      expect(migrated.output).toContain(await expectedPendingBanner());

      await database.client.query(
        "UPDATE drizzle.__drizzle_migrations SET hash = 'checkpoint-drift' WHERE created_at = $1",
        [CATALOG_GUARD_CREATED_AT],
      );
      const checkpointMismatch = await runScript(MIGRATOR, database.url);
      expect(checkpointMismatch.exitCode).toBe(1);
      expect(checkpointMismatch.output).toContain(
        "Migration ledger hash mismatch for 0194_job_execution_interruptions_catalog_guard",
      );
      await database.client.end();
    }, 30_000);

    test("accepts production timestamp order when legacy journal indexes invert", async () => {
      const database = await createDatabase();
      await seedAppliedPrefix(
        database.client,
        CHECKPOINT_PREFIX_LENGTH,
        "timestamp",
      );
      const entries = await journalEntries();
      const earlierTimestamp = entries[44];
      const laterTimestamp = entries[43];
      if (!earlierTimestamp || !laterTimestamp) {
        throw new Error("Missing production inversion fixture entries");
      }
      expect(earlierTimestamp.tag).toBe("0044_seed_chain_data_pricing");
      expect(laterTimestamp.tag).toBe(
        "0043_add_missing_referral_context_columns",
      );
      expect(earlierTimestamp.when).toBeLessThan(laterTimestamp.when);

      const inversion = await database.client.query<{
        id: number;
        created_at: string;
      }>(
        `SELECT id, created_at::text
         FROM drizzle.__drizzle_migrations
         WHERE created_at = ANY($1::bigint[])
         ORDER BY id ASC`,
        [[earlierTimestamp.when, laterTimestamp.when]],
      );
      expect(inversion.rows.map((row) => Number(row.created_at))).toEqual([
        earlierTimestamp.when,
        laterTimestamp.when,
      ]);

      const migrated = await runScript(MIGRATOR, database.url);
      expect(migrated.exitCode, migrated.output).toBe(0);
      expect(migrated.output).toContain(await expectedPendingBanner());
      await database.client.end();
    }, 120_000);

    test("accepts historical journal order when legacy timestamps invert", async () => {
      const database = await createDatabase();
      await seedAppliedPrefix(
        database.client,
        CHECKPOINT_PREFIX_LENGTH,
        "journal",
      );

      const migrated = await runScript(MIGRATOR, database.url);
      expect(migrated.exitCode, migrated.output).toBe(0);
      expect(migrated.output).toContain(await expectedPendingBanner());
      await database.client.end();
    }, 120_000);

    test("accepts the production hybrid order with late historical backfills", async () => {
      const database = await createDatabase();
      await seedAppliedPrefix(
        database.client,
        CHECKPOINT_PREFIX_LENGTH,
        "production-hybrid",
      );
      const entries = await journalEntries();
      const encryptionKeys = entries[17];
      const databaseOptimization = entries[81];
      const managedDomains = entries[101];
      if (!encryptionKeys || !databaseOptimization || !managedDomains) {
        throw new Error("Missing production hybrid fixture entries");
      }

      const appliedOrder = await database.client.query<{
        created_at: string;
      }>(
        `SELECT created_at::text
         FROM drizzle.__drizzle_migrations
         WHERE created_at = ANY($1::bigint[])
         ORDER BY id ASC`,
        [[managedDomains.when, encryptionKeys.when, databaseOptimization.when]],
      );
      expect(appliedOrder.rows.map((row) => Number(row.created_at))).toEqual([
        managedDomains.when,
        encryptionKeys.when,
        databaseOptimization.when,
      ]);

      const migrated = await runScript(MIGRATOR, database.url);
      expect(migrated.exitCode, migrated.output).toBe(0);
      expect(migrated.output).toContain(await expectedPendingBanner());
      await database.client.end();
    }, 120_000);

    test("accepts production schema history missing ledger rows before the checkpoint", async () => {
      const database = await createDatabase();
      await seedAppliedPrefix(
        database.client,
        CHECKPOINT_PREFIX_LENGTH,
        "production-hybrid",
      );
      const entries = await journalEntries();
      const missingEntries = PRODUCTION_UNRECORDED_TAGS.map((tag) => {
        const entry = entries.find((candidate) => candidate.tag === tag);
        if (!entry) throw new Error(`Missing production ledger fixture ${tag}`);
        return entry;
      });
      await database.client.query(
        "DELETE FROM drizzle.__drizzle_migrations WHERE created_at = ANY($1::bigint[])",
        [missingEntries.map((entry) => entry.when)],
      );

      const migrated = await runScript(MIGRATOR, database.url);
      expect(migrated.exitCode, migrated.output).toBe(0);
      expect(migrated.output).toContain(await expectedPendingBanner());

      const remaining = await database.client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations WHERE created_at = ANY($1::bigint[])",
        [missingEntries.map((entry) => entry.when)],
      );
      expect(remaining.rows[0]?.count).toBe("0");
      await database.client.end();
    }, 120_000);

    test("rejects historical rows appended after the immutable checkpoint", async () => {
      const database = await createDatabase();
      await seedAppliedPrefix(database.client, CHECKPOINT_PREFIX_LENGTH);
      const entries = await journalEntries();
      for (const journalIndex of [193, 184, 185]) {
        const entry = entries[journalIndex];
        if (!entry) throw new Error(`Missing journal entry ${journalIndex}`);
        const sql = await readFile(
          path.join(MIGRATIONS_DIR, `${entry.tag}.sql`),
          "utf8",
        );
        await database.client.query(
          "INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)",
          [createHash("sha256").update(sql).digest("hex"), entry.when],
        );
      }

      const result = await runScript(MIGRATOR, database.url);
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain(
        "appears after hash enforcement checkpoint",
      );
      await database.client.end();
    }, 120_000);

    test("rejects incompatible catalog drift and malformed ledger prefixes", async () => {
      const drift = await createDatabase();
      await seedAppliedPrefix(drift.client, CHECKPOINT_PREFIX_LENGTH);
      await drift.client.query(
        "ALTER TABLE jobs ADD COLUMN execution_interruptions text DEFAULT 'wrong'",
      );
      const driftResult = await runScript(MIGRATOR, drift.url);
      expect(driftResult.exitCode).toBe(1);
      expect(driftResult.output).toContain(
        "jobs.execution_interruptions catalog mismatch",
      );
      const driftJournal = await drift.client.query<{
        add_column: string;
        catalog_guard: string;
      }>(
        `SELECT
          count(*) FILTER (WHERE created_at = $1)::text AS add_column,
          count(*) FILTER (WHERE created_at = $2)::text AS catalog_guard
         FROM drizzle.__drizzle_migrations`,
        [ADD_COLUMN_CREATED_AT, CATALOG_GUARD_CREATED_AT],
      );
      expect(driftJournal.rows[0]).toEqual({
        add_column: "1",
        catalog_guard: "0",
      });
      await drift.client.end();

      const generated = await createDatabase();
      await seedAppliedPrefix(generated.client, CHECKPOINT_PREFIX_LENGTH);
      await generated.client.query(
        "ALTER TABLE jobs ADD COLUMN execution_interruptions integer GENERATED ALWAYS AS (0) STORED NOT NULL",
      );
      const generatedResult = await runScript(MIGRATOR, generated.url);
      expect(generatedResult.exitCode).toBe(1);
      expect(generatedResult.output).toContain(
        "expected writable integer NOT NULL DEFAULT 0",
      );
      await generated.client.end();

      const duplicate = await createDatabase();
      await seedAppliedPrefix(duplicate.client, CHECKPOINT_PREFIX_LENGTH);
      const last = (
        await duplicate.client.query<{ hash: string; created_at: string }>(
          "SELECT hash, created_at::text FROM drizzle.__drizzle_migrations ORDER BY id DESC LIMIT 1",
        )
      ).rows[0];
      await duplicate.client.query(
        "INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)",
        [last?.hash, last?.created_at],
      );
      const duplicateResult = await runScript(MIGRATOR, duplicate.url);
      expect(duplicateResult.exitCode).toBe(1);
      expect(duplicateResult.output).toContain("duplicate created_at");
      await duplicate.client.end();

      const unknownRow = await createDatabase();
      await seedAppliedPrefix(unknownRow.client, CHECKPOINT_PREFIX_LENGTH);
      await unknownRow.client.query(
        "INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('unknown', 9999999999999)",
      );
      const unknownRowResult = await runScript(MIGRATOR, unknownRow.url);
      expect(unknownRowResult.exitCode).toBe(1);
      expect(unknownRowResult.output).toContain("no matching journal entry");
      await unknownRow.client.end();
    }, 300_000);

    test("serializes concurrent migrators and recovers from table-lock contention", async () => {
      const database = await createDatabase();
      await seedAppliedPrefix(database.client, CHECKPOINT_PREFIX_LENGTH);
      const holder = new Client({ connectionString: database.url });
      await holder.connect();
      await holder.query("BEGIN");
      await holder.query("SELECT count(*) FROM jobs");

      const firstPromise = runScript(MIGRATOR, database.url, {
        MIGRATION_LOCK_MAX_ATTEMPTS: "100",
      });
      const secondPromise = runScript(MIGRATOR, database.url, {
        MIGRATION_LOCK_MAX_ATTEMPTS: "100",
      });
      await waitForAdvisoryLock(database.client);
      await Bun.sleep(250);
      await holder.query("COMMIT");
      await holder.end();

      const [first, second] = await Promise.all([firstPromise, secondPromise]);
      expect(first.exitCode, first.output).toBe(0);
      expect(second.exitCode, second.output).toBe(0);
      const output = `${first.output}${second.output}`;
      expect(output).toContain("lock timeout on attempt");
      expect(output).toContain("migration lock busy on attempt");
      expect(output).toContain("pending migrations: 0");

      const journal = await database.client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations WHERE created_at = $1",
        [CATALOG_GUARD_CREATED_AT],
      );
      expect(journal.rows[0]?.count).toBe("1");
      await database.client.end();
    }, 30_000);

    test("fails observably after bounded table-lock retries without partial state", async () => {
      const database = await createDatabase();
      await seedAppliedPrefix(database.client, CHECKPOINT_PREFIX_LENGTH);
      const holder = new Client({ connectionString: database.url });
      await holder.connect();
      await holder.query("BEGIN");
      await holder.query("SELECT count(*) FROM jobs");

      const result = await runScript(MIGRATOR, database.url, {
        MIGRATION_LOCK_TIMEOUT_MS: "50",
        MIGRATION_LOCK_MAX_ATTEMPTS: "2",
        MIGRATION_LOCK_RETRY_BASE_MS: "1",
        MIGRATION_LOCK_RETRY_MAX_MS: "1",
      });
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("exhausted 2 lock-timeout attempts");
      expect(result.output).toContain("code=55P03");

      const state = await database.client.query<{
        columns: string;
        journal: string;
      }>(`
      SELECT
        (SELECT count(*)::text
         FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'jobs'
           AND column_name = 'execution_interruptions') AS columns,
        (SELECT count(*)::text
         FROM drizzle.__drizzle_migrations
         WHERE created_at IN (${ADD_COLUMN_CREATED_AT}, ${CATALOG_GUARD_CREATED_AT})) AS journal
    `);
      expect(state.rows[0]).toEqual({ columns: "0", journal: "0" });

      await holder.query("ROLLBACK");
      await holder.end();
      await database.client.end();
    }, 30_000);
  },
);
