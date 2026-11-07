/** Full fixed-object catalog evidence; stored definitions never leave this module. */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { AuditQueryClient } from "./audit-production-railway-database-authority";

const QUERY = `WITH target AS (SELECT to_regclass('public.managed_gmail_operation_receipts') AS oid)
SELECT jsonb_build_object(
 'table',(SELECT jsonb_build_object('kind',relkind,'persistence',relpersistence,'rowSecurity',relrowsecurity,'forceRowSecurity',relforcerowsecurity,'defaultAcl',relacl IS NULL,'ownedByExpectedRole',relowner=(SELECT oid FROM pg_roles WHERE rolname=$1),'partition',relispartition) FROM pg_class WHERE oid=(SELECT oid FROM target)),
 'columns',(SELECT COALESCE(jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'notNull',a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid),'identity',a.attidentity,'generated',a.attgenerated,'collation',a.attcollation::regcollation::text,'defaultAcl',a.attacl IS NULL) ORDER BY a.attnum),'[]'::jsonb) FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=(SELECT oid FROM target) AND a.attnum>0 AND NOT a.attisdropped),
 'constraints',(SELECT COALESCE(jsonb_agg(jsonb_build_object('name',conname,'definition',pg_get_constraintdef(oid),'validated',convalidated,'enforced',COALESCE((to_jsonb(pg_constraint)->>'conenforced')::boolean,true),'deferrable',condeferrable,'deferred',condeferred) ORDER BY conname),'[]'::jsonb) FROM pg_constraint WHERE conrelid=(SELECT oid FROM target)),
 'indexes',(SELECT COALESCE(jsonb_agg(jsonb_build_object('name',c.relname,'definition',pg_get_indexdef(i.indexrelid),'valid',i.indisvalid,'ready',i.indisready,'unique',i.indisunique) ORDER BY c.relname),'[]'::jsonb) FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE i.indrelid=(SELECT oid FROM target)),
 'triggers',(SELECT COALESCE(jsonb_agg(jsonb_build_object('name',tgname,'definition',pg_get_triggerdef(oid),'enabled',tgenabled) ORDER BY tgname),'[]'::jsonb) FROM pg_trigger WHERE tgrelid=(SELECT oid FROM target) AND NOT tgisinternal),
 'internalTriggers',(SELECT COALESCE(jsonb_agg(jsonb_build_object('relation',t.tgrelid::regclass::text,'function',t.tgfoid::regprocedure::text,'type',t.tgtype,'enabled',t.tgenabled,'constraint',c.conname,'deferrable',t.tgdeferrable,'deferred',t.tginitdeferred,'args',encode(t.tgargs,'hex'),'qual',pg_get_expr(t.tgqual,t.tgrelid)) ORDER BY t.tgrelid::regclass::text,c.conname,t.tgtype,t.tgfoid::regprocedure::text),'[]'::jsonb) FROM pg_trigger t LEFT JOIN pg_constraint c ON c.oid=t.tgconstraint WHERE t.tgisinternal AND (t.tgrelid=(SELECT oid FROM target) OR t.tgconstraint IN(SELECT oid FROM pg_constraint WHERE conrelid=(SELECT oid FROM target)))),
 'inheritance',(SELECT COALESCE(jsonb_agg(jsonb_build_object('child',inhrelid::regclass::text,'parent',inhparent::regclass::text) ORDER BY inhrelid,inhparent),'[]'::jsonb) FROM pg_inherits WHERE inhrelid=(SELECT oid FROM target) OR inhparent=(SELECT oid FROM target)),
 'rules',(SELECT COALESCE(jsonb_agg(pg_get_ruledef(oid) ORDER BY rulename),'[]'::jsonb) FROM pg_rewrite WHERE ev_class=(SELECT oid FROM target)),
 'incomingConstraints',(SELECT COALESCE(jsonb_agg(pg_get_constraintdef(oid) ORDER BY conname),'[]'::jsonb) FROM pg_constraint WHERE confrelid=(SELECT oid FROM target)),
 'policies',(SELECT COALESCE(jsonb_agg(polname ORDER BY polname),'[]'::jsonb) FROM pg_policy WHERE polrelid=(SELECT oid FROM target)),
 'functions',(SELECT COALESCE(jsonb_agg(jsonb_build_object('definition',pg_get_functiondef(p.oid),'defaultAcl',p.proacl IS NULL,'ownedByExpectedRole',p.proowner=(SELECT oid FROM pg_roles WHERE rolname=$2)) ORDER BY p.oid),'[]'::jsonb) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='guard_managed_gmail_operation_receipt')
) AS catalog`;

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, v]) => `${JSON.stringify(key)}:${stable(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
/** Rehearsal fixture generation only; never print a production result. */
export interface GmailOwnershipPolicy {
  tableOwnerRole: string;
  functionOwnerRole: string;
}
export async function readGmailRecoveryCatalog(
  client: AuditQueryClient,
  policy: GmailOwnershipPolicy,
): Promise<unknown> {
  const result = await client.query<{ catalog: unknown }>(QUERY, [
    policy.tableOwnerRole,
    policy.functionOwnerRole,
  ]);
  if (result.rows.length !== 1 || !result.rows[0]?.catalog)
    throw Error("gmail_catalog_unavailable");
  return result.rows[0].catalog;
}
export async function assertGmailRecoveryCatalog(
  client: AuditQueryClient,
  policy: GmailOwnershipPolicy,
): Promise<void> {
  try {
    const version = await client.query<{ major: number }>(
      "SELECT current_setting('server_version_num')::integer / 10000 AS major",
    );
    const major = version.rows[0]?.major;
    if (version.rows.length !== 1 || (major !== 17 && major !== 18))
      throw Error("unsupported_catalog_version");
    const fixturePath =
      major === 18
        ? "./fixtures/gmail-recovery-catalog-pg18.json"
        : "./fixtures/gmail-recovery-catalog.json";
    const fixture = JSON.parse(
      await readFile(new URL(fixturePath, import.meta.url), "utf8"),
    );
    const sourceTags = fixture.sources
      .map((source: { tag: string }) => source.tag)
      .sort();
    if (
      JSON.stringify(sourceTags) !==
      JSON.stringify([
        "0509_managed_gmail_operation_receipts",
        "0535_managed_gmail_read_state_operations",
      ])
    )
      throw Error("source_guard");
    for (const source of fixture.sources) {
      if (
        ![
          "0509_managed_gmail_operation_receipts",
          "0535_managed_gmail_read_state_operations",
        ].includes(source.tag)
      )
        throw Error("source_guard");
      const sql = await readFile(
        new URL(
          `../../shared/src/db/migrations/${source.tag}.sql`,
          import.meta.url,
        ),
        "utf8",
      );
      if (createHash("sha256").update(sql).digest("hex") !== source.sha256)
        throw Error("source_guard");
    }
    if (fixture.sources.length !== 2) throw Error("source_guard");
    if (
      stable(await readGmailRecoveryCatalog(client, policy)) !==
      stable(fixture.catalog)
    )
      throw Error("mismatch");
  } catch {
    // error-policy:J1 never publish private definitions or database errors.
    throw Error("gmail_recovery_catalog_mismatch");
  }
}
