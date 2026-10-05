/** Applies the shipped privacy/security migrations to real predecessor tables. */

import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const migration = (name: string) =>
  readFile(new URL(`./migrations/${name}.sql`, import.meta.url), "utf8");
const org = "00000000-0000-4000-8000-000000000001";
const otherOrg = "00000000-0000-4000-8000-000000000002";
const user = "00000000-0000-4000-8000-000000000003";
const app = "00000000-0000-4000-8000-000000000004";
const key = "00000000-0000-4000-8000-000000000005";

test("ordered migrations preserve scrub scope, consent constraints, and notification custody", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE TABLE organizations (id uuid PRIMARY KEY);
      CREATE TABLE users (id uuid PRIMARY KEY);
      CREATE TABLE apps (id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id));
      INSERT INTO organizations VALUES ('${org}'), ('${otherOrg}');
      INSERT INTO users VALUES ('${user}');
      INSERT INTO apps VALUES ('${app}', '${org}');
    `);
    await db.exec(await migration("0175_pii_scrub_markers"));
    await db.exec(await migration("0413_app_billing_notification_endpoints"));
    const marker = (organization: string, scope?: string) =>
      db.query(
        `INSERT INTO pii_scrub_markers
        (organization_id, marker_key, content_hash, ruleset_version, model_id, tier0_only${scope ? ", inspection_scope" : ""})
        VALUES ($1, 'same-content', 'fixture-hash', 'v1', 'tier0', true${scope ? ", $2" : ""})`,
        scope ? [organization, scope] : [organization],
      );
    await marker(org);
    const insertEndpoint = (secret: string, organization = org) =>
      db.query(
        `INSERT INTO app_billing_notification_endpoints
        (app_id, organization_id, livemode, endpoint_url, active_key_id, active_secret)
        VALUES ($1, $2, false, 'https://example.com/notifications', $3, $4) RETURNING id`,
        [app, organization, key, secret],
      );
    await expect(insertEndpoint("enc:v2:fixture-envelope")).rejects.toThrow("encrypted storage");
    for (const name of [
      "0506_pii_scrub_markers_inspection_scope",
      "0507_user_consents",
      "0508_app_notification_secret_envelope_v2",
    ]) {
      await db.exec(await migration(name));
    }
    expect(
      (
        await db.query<{ inspection_scope: string; candidate_count: number }>(
          "SELECT inspection_scope, candidate_count FROM pii_scrub_markers",
        )
      ).rows,
    ).toEqual([{ inspection_scope: "declared_candidates", candidate_count: 0 }]);
    await marker(org, "server_discovery");
    await marker(otherOrg, "server_discovery");
    await expect(marker(org, "server_discovery")).rejects.toThrow("duplicate key");
    await expect(marker(org, "untrusted_scope")).rejects.toThrow("inspection_scope_check");
    await db.query(
      `INSERT INTO user_consents (user_id, organization_id, purpose, granted, policy_version, source)
       VALUES ($1, $2, 'vision_capture', true, 'fixture-policy', 'settings')`,
      [user, org],
    );
    await expect(
      db.query(
        `INSERT INTO user_consents (user_id, organization_id, purpose, granted, policy_version, source)
       VALUES ($1, $2, 'model_training', true, 'fixture-policy', 'settings')`,
        [user, org],
      ),
    ).rejects.toThrow("user_consents_purpose_check");
    await expect(insertEndpoint("plaintext")).rejects.toThrow("encrypted storage");
    await expect(insertEndpoint("enc:v2:fixture-envelope", otherOrg)).rejects.toThrow(
      "organization must own application",
    );
    const endpoint = (await insertEndpoint("enc:v2:fixture-envelope")).rows[0] as { id: string };
    await expect(
      db.query("UPDATE app_billing_notification_endpoints SET livemode = true WHERE id = $1", [
        endpoint.id,
      ]),
    ).rejects.toThrow("identity is immutable");
    await db.query(
      "UPDATE app_billing_notification_endpoints SET active_secret = $1 WHERE id = $2",
      ["enc:v1:legacy-envelope", endpoint.id],
    );
    // Reapplying the additive migrations leaves existing data and guards intact.
    for (const name of [
      "0506_pii_scrub_markers_inspection_scope",
      "0507_user_consents",
      "0508_app_notification_secret_envelope_v2",
    ]) {
      await db.exec(await migration(name));
    }
    expect((await db.query("SELECT * FROM pii_scrub_markers")).rows).toHaveLength(3);
    await db.query("DELETE FROM users WHERE id = $1", [user]);
    expect((await db.query("SELECT * FROM user_consents")).rows).toHaveLength(0);
  } finally {
    await db.close();
  }
}, 60_000);
