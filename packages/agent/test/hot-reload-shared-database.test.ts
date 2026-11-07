/** A CLI-host hot reload stops the replaced runtime without closing the database connection its replacement reuses. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentRuntime, stringToUuid, type UUID } from "@elizaos/core";
import { createDatabaseAdapter } from "@elizaos/plugin-sql";
import { afterEach, expect, it } from "vitest";
import {
  closeRuntimeAdapter,
  disposeReplacedRuntime,
} from "../src/runtime/eliza.ts";

const directories: string[] = [];
const agentId = stringToUuid("hot-reload-shared-database") as UUID;

afterEach(async () => {
  for (const dir of directories.splice(0))
    await rm(dir, { recursive: true, force: true });
});

async function runtimeOn(dataDir: string): Promise<AgentRuntime> {
  const adapter = createDatabaseAdapter({ dataDir }, agentId);
  await adapter.initialize();
  return new AgentRuntime({
    agentId,
    character: { name: "HotReload" },
    adapter,
  });
}

async function selectOne(runtime: AgentRuntime): Promise<unknown> {
  const raw = (
    runtime.adapter as unknown as {
      getRawConnection(): { query(sql: string): Promise<{ rows: unknown[] }> };
    }
  ).getRawConnection();
  return (await raw.query("select 1 as ok")).rows[0];
}

it("keeps the shared connection open for the replacement and closes it on the replacement's shutdown", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "eliza-hot-reload-db-"));
  directories.push(dataDir);
  const previous = await runtimeOn(dataDir);
  const replacement = await runtimeOn(dataDir);

  await disposeReplacedRuntime(previous, replacement);

  expect(await selectOne(replacement)).toEqual({ ok: 1 });
  await closeRuntimeAdapter(replacement, "final shutdown");
  await expect(selectOne(replacement)).rejects.toThrow();
}, 120_000);

it("closes the replaced runtime's database when the replacement uses another one", async () => {
  const first = await mkdtemp(path.join(tmpdir(), "eliza-hot-reload-db-a-"));
  const second = await mkdtemp(path.join(tmpdir(), "eliza-hot-reload-db-b-"));
  directories.push(first, second);
  const previous = await runtimeOn(first);
  const replacement = await runtimeOn(second);

  await disposeReplacedRuntime(previous, replacement);

  await expect(selectOne(previous)).rejects.toThrow();
  expect(await selectOne(replacement)).toEqual({ ok: 1 });
  await closeRuntimeAdapter(replacement, "final shutdown");
}, 120_000);
