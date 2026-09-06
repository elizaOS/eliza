/** Applies real cleanup/revision migrations and exercises the candidate VPN ownership constraint. */

import { test } from "bun:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { agentSandboxes } from "../schemas/agent-sandboxes";

const migrations = new URL("./", import.meta.url);
test.each(["migration", "schema"] as const)(
  "VPN cleanup %s preserves ownership and revision across retries",
  async (source) => {
    const db = new PGlite();
    try {
      await db.exec(
        "CREATE TABLE agent_sandboxes (id uuid PRIMARY KEY, claimed_at timestamptz, updated_at timestamptz, lifecycle_revision bigint NOT NULL DEFAULT 0)",
      );
      for (const name of [
        "0182_warm_claim_credential_fence.sql",
        "0189_agent_sandbox_lifecycle_revision_scope.sql",
        "0368_agent_replacement_vpn_authority.sql",
      ])
        await db.exec(await readFile(new URL(name, migrations), "utf8"));
      const constraint = await readFile(
        new URL("0368_agent_replacement_vpn_authority.sql", migrations),
        "utf8",
      );
      await db.exec(constraint);
      if (source === "schema") {
        const check = getTableConfig(agentSandboxes).checks.find(
          (entry) => entry.name === "agent_sandboxes_replacement_vpn_authority_check",
        );
        if (!check) throw new Error("VPN ownership constraint unavailable");
        const compiled = new PgDialect().sqlToQuery(check.value);
        await db.exec(
          `ALTER TABLE agent_sandboxes DROP CONSTRAINT agent_sandboxes_replacement_vpn_authority_check`,
        );
        await db.exec(
          `ALTER TABLE agent_sandboxes ADD CONSTRAINT agent_sandboxes_replacement_vpn_authority_check CHECK (${compiled.sql})`,
        );
      }
      const id = "11111111-1111-4111-8111-111111111111";
      const server = {
        apiUrl: "https://vpn.fixture.invalid",
        enrollmentUser: "staging",
        publicKey: "mkey:" + "1".repeat(64),
      };
      const node = {
        id: "42",
        machineKey: "mkey:" + "2".repeat(64),
        createdAt: "2026-09-06T00:00:00.000Z",
      };
      await db.query("INSERT INTO agent_sandboxes (id) VALUES ($1)", [id]);
      await db.query(
        `UPDATE agent_sandboxes SET replacement_cleanup_sandbox_id='candidate',replacement_cleanup_node_id='host',replacement_cleanup_container_name='candidate',replacement_cleanup_attempt_id=$1,replacement_cleanup_allocation_counted=true,replacement_cleanup_created_at=now(),replacement_cleanup_vpn_node_name='candidate',replacement_cleanup_vpn_registration_started_at=now(),replacement_cleanup_vpn_authority=$2 WHERE id=$3`,
        [crypto.randomUUID(), { server, node: null }, id],
      );
      const read = async () =>
        (
          await db.query<{
            lifecycle_revision: number;
            replacement_cleanup_vpn_authority: {
              server: typeof server;
              node: typeof node | null;
            } | null;
          }>("SELECT * FROM agent_sandboxes WHERE id=$1", [id])
        ).rows[0];
      const admitted = await read();
      assert.equal(admitted.lifecycle_revision, 1);
      await db.query(
        `UPDATE agent_sandboxes SET replacement_cleanup_vpn_node_id='42',replacement_cleanup_vpn_authority=$1 WHERE id=$2`,
        [{ server, node }, id],
      );
      const registered = await read();
      assert.equal(registered.lifecycle_revision, 2);
      await assert.rejects(
        db.query(`UPDATE agent_sandboxes SET replacement_cleanup_vpn_node_id='43' WHERE id=$1`, [
          id,
        ]),
        { code: "23514" },
      );
      assert.deepEqual(await read(), registered);
      for (const malformed of [
        null,
        {},
        { server },
        { server, node: { ...node, id: 42 } },
        { server: { ...server, publicKey: "mkey:" + "0".repeat(64) }, node },
        { server, node: { ...node, machineKey: "mkey:" + "0".repeat(64) } },
      ]) {
        await assert.rejects(
          db.query(
            "UPDATE agent_sandboxes SET replacement_cleanup_vpn_authority=$1::jsonb WHERE id=$2",
            [JSON.stringify(malformed), id],
          ),
          { code: "23514" },
        );
        assert.deepEqual(await read(), registered);
      }
      await db.exec(constraint);
      assert.deepEqual(await read(), registered);
      await db.query(
        `UPDATE agent_sandboxes SET replacement_cleanup_sandbox_id=NULL,replacement_cleanup_node_id=NULL,replacement_cleanup_container_name=NULL,replacement_cleanup_attempt_id=NULL,replacement_cleanup_container_id=NULL,replacement_cleanup_vpn_node_id=NULL,replacement_cleanup_vpn_node_name=NULL,replacement_cleanup_preserved_vpn_node_id=NULL,replacement_cleanup_vpn_registration_started_at=NULL,replacement_cleanup_allocation_counted=NULL,replacement_cleanup_created_at=NULL,replacement_cleanup_vpn_authority=NULL WHERE id=$1`,
        [id],
      );
      const cleared = await read();
      assert.equal(cleared.lifecycle_revision, 3);
      assert.equal(cleared.replacement_cleanup_vpn_authority, null);
      await assert.rejects(
        db.query("UPDATE agent_sandboxes SET replacement_cleanup_vpn_authority=$1 WHERE id=$2", [
          { server, node: null },
          id,
        ]),
        { code: "23514" },
      );
      assert.deepEqual(await read(), cleared);
    } finally {
      await db.close();
    }
  },
  60_000,
);
