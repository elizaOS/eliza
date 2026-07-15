/**
 * Composed real-PGlite lane for `src/base.ts` — imports every hermetic
 * integration suite so the changed-file coverage gate can execute the
 * adapter's actual behavioral matrix (real DDL, real queries, real vectors)
 * against a `BaseDrizzleAdapter` change. The `.real.test.ts` filename filter
 * keeps these suites out of the gate individually; each one is in-process
 * PGlite via `createIsolatedTestDatabase` with no network or credentials, so
 * composing them here trades no hermeticity for real coverage.
 *
 * Runs only under `vitest.harness.config.ts` (the default package config never
 * includes plugin-root `__tests__/`), so the fast PR lane is unchanged.
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import "../src/__tests__/integration/advanced-memory-storage.real.test.ts";
import "../src/__tests__/integration/agent.real.test.ts";
import "../src/__tests__/integration/base-adapter-methods.real.test.ts";
import "../src/__tests__/integration/base-comprehensive.real.test.ts";
import "../src/__tests__/integration/cache.real.test.ts";
import "../src/__tests__/integration/cascade-delete.real.test.ts";
import "../src/__tests__/integration/component.real.test.ts";
import "../src/__tests__/integration/connector-account-storage.real.test.ts";
import "../src/__tests__/integration/connectorAccount.store.real.test.ts";
import "../src/__tests__/integration/db-failure-error-path.real.test.ts";
import "../src/__tests__/integration/embedding.real.test.ts";
import "../src/__tests__/integration/entity-array-fix.real.test.ts";
import "../src/__tests__/integration/entity-crud.real.test.ts";
import "../src/__tests__/integration/entity-methods.real.test.ts";
import "../src/__tests__/integration/entity.real.test.ts";
import "../src/__tests__/integration/log.real.test.ts";
import "../src/__tests__/integration/memory-keyword-search.real.test.ts";
import "../src/__tests__/integration/memory-text-contains.real.test.ts";
import "../src/__tests__/integration/memory-worldid.real.test.ts";
import "../src/__tests__/integration/memory.real.test.ts";
import "../src/__tests__/integration/messaging.real.test.ts";
import "../src/__tests__/integration/participant.real.test.ts";
import "../src/__tests__/integration/relationship.real.test.ts";
import "../src/__tests__/integration/room.real.test.ts";
import "../src/__tests__/integration/sub-agent-entity-unlink.real.test.ts";
import "../src/__tests__/integration/task.real.test.ts";
import "../src/__tests__/integration/utils.real.test.ts";
import "../src/__tests__/integration/world.real.test.ts";

describe("base-adapter harness lane composition", () => {
  it("imports every hermetic integration suite in the directory", () => {
    const selfSource = readFileSync(fileURLToPath(import.meta.url), "utf8");
    const imported = [
      ...selfSource.matchAll(
        /import "\.\.\/src\/__tests__\/integration\/([^"]+)";/g,
      ),
    ]
      .map((match) => match[1])
      .sort();
    const onDisk = readdirSync(
      fileURLToPath(new URL("../src/__tests__/integration", import.meta.url)),
    )
      .filter(
        (name) =>
          name.endsWith(".real.test.ts") && !name.endsWith(".real.e2e.test.ts"),
      )
      .sort();
    expect(imported).toEqual(onDisk);
  });
});
