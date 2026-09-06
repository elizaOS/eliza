/** Exercises retiring placement ownership with real migration SQL and Drizzle checks in PGlite. */
import { test } from "bun:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { agentSandboxes } from "../schemas/agent-sandboxes";

test.each(["migration", "schema"] as const)(
  "retiring serving placement %s cannot outlive or change its cleanup owner",
  async (source) => {
    const db = new PGlite();
    try {
      await db.exec(
        "CREATE TABLE agent_sandboxes (id uuid PRIMARY KEY, organization_id uuid NOT NULL, claimed_at timestamptz, updated_at timestamptz, lifecycle_revision bigint NOT NULL DEFAULT 0)",
      );
      for (const name of [
        "0182_warm_claim_credential_fence.sql",
        "0189_agent_sandbox_lifecycle_revision_scope.sql",
        "0380_agent_retiring_serving_placement.sql",
      ]) {
        await db.exec(await readFile(new URL(name, import.meta.url), "utf8"));
      }
      const migration = await readFile(
        new URL("0380_agent_retiring_serving_placement.sql", import.meta.url),
        "utf8",
      );
      if (source === "schema") {
        const check = getTableConfig(agentSandboxes).checks.find(
          (entry) => entry.name === "agent_sandboxes_replacement_resource_manifest_check",
        );
        assert.ok(check);
        const compiled = new PgDialect().sqlToQuery(check.value);
        await db.exec(
          "ALTER TABLE agent_sandboxes DROP CONSTRAINT agent_sandboxes_replacement_resource_manifest_check",
        );
        await db.exec(
          `ALTER TABLE agent_sandboxes ADD CONSTRAINT agent_sandboxes_replacement_resource_manifest_check CHECK (${compiled.sql})`,
        );
      }
      const id = crypto.randomUUID();
      const placement = {
        version: 1,
        volumePath: "/var/lib/eliza/agents/retained",
        locator: {
          sandboxId: "old-sandbox",
          nodeId: "old-node",
          containerName: "old-container",
          containerId: "a".repeat(64),
        },
      };
      const receipt = {
        version: 1,
        deletionAttemptId: crypto.randomUUID(),
        agentId: id,
        organizationId: crypto.randomUUID(),
        deletionPolicy: { kind: "recovery_required" },
        servingPlacement: placement,
        localStateRetention: null,
        resources: {
          volume: { state: "unknown" },
          secrets: { state: "unknown" },
          vpn: { state: "unknown" },
        },
      };
      await db.query("INSERT INTO agent_sandboxes (id, organization_id) VALUES ($1, $2)", [
        id,
        receipt.organizationId,
      ]);
      const read = async () =>
        (
          await db.query<{ replacement_cleanup_resource_manifest: typeof receipt | null }>(
            "SELECT * FROM agent_sandboxes WHERE id=$1",
            [id],
          )
        ).rows[0];
      const empty = await read();
      await assert.rejects(
        db.query(
          "UPDATE agent_sandboxes SET replacement_cleanup_resource_manifest=$1 WHERE id=$2",
          [receipt, id],
        ),
        { code: "23514" },
      );
      assert.deepEqual(await read(), empty);
      await db.query(
        "UPDATE agent_sandboxes SET replacement_cleanup_sandbox_id='old-sandbox',replacement_cleanup_node_id='old-node',replacement_cleanup_container_name='old-container',replacement_cleanup_allocation_counted=true,replacement_cleanup_created_at=now(),replacement_cleanup_resource_manifest=$1 WHERE id=$2",
        [receipt, id],
      );
      const owned = await read();
      for (const invalid of [
        {},
        { ...receipt, version: 2 },
        { ...receipt, agentId: crypto.randomUUID() },
        { ...receipt, organizationId: crypto.randomUUID() },
        { ...receipt, deletionPolicy: { kind: "account_purge" } },
        { ...receipt, deletionAttemptId: "" },
        {
          ...receipt,
          servingPlacement: { ...placement, locator: { ...placement.locator, nodeId: "new-node" } },
        },
        {
          ...receipt,
          servingPlacement: {
            ...placement,
            locator: { ...placement.locator, containerName: "new-container" },
          },
        },
        {
          ...receipt,
          servingPlacement: {
            ...placement,
            locator: { ...placement.locator, sandboxId: "new-sandbox" },
          },
        },
      ]) {
        await assert.rejects(
          db.query(
            "UPDATE agent_sandboxes SET replacement_cleanup_resource_manifest=$1 WHERE id=$2",
            [invalid, id],
          ),
          { code: "23514" },
        );
        assert.deepEqual(await read(), owned);
      }
      await assert.rejects(
        db.query(
          "UPDATE agent_sandboxes SET replacement_cleanup_sandbox_id=NULL,replacement_cleanup_node_id=NULL,replacement_cleanup_container_name=NULL,replacement_cleanup_allocation_counted=NULL,replacement_cleanup_created_at=NULL WHERE id=$1",
          [id],
        ),
        { code: "23514" },
      );
      assert.deepEqual(await read(), owned);
      for (const statement of migration.split("--> statement-breakpoint")) {
        if (statement.trim()) await db.query(statement);
      }
      assert.deepEqual(await read(), owned);
      await db.query(
        "UPDATE agent_sandboxes SET replacement_cleanup_sandbox_id=NULL,replacement_cleanup_node_id=NULL,replacement_cleanup_container_name=NULL,replacement_cleanup_allocation_counted=NULL,replacement_cleanup_created_at=NULL,replacement_cleanup_resource_manifest=NULL WHERE id=$1",
        [id],
      );
      assert.equal((await read()).replacement_cleanup_resource_manifest, null);
    } finally {
      await db.close();
    }
  },
  60_000,
);
