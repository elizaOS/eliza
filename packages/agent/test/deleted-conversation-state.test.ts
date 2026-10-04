/** Durable tombstones survive replacement; corrupt state blocks host startup. */
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentRuntime } from "@elizaos/core";
import { SQLiteDatabaseAdapter } from "@elizaos/testing/runtime";
import { afterEach, expect, it, vi } from "vitest";
import { startApiServer } from "../src/api/server.ts";
import {
  persistDeletedConversationIdsToState,
  readDeletedConversationIdsFromState,
} from "../src/api/server-helpers.ts";

let directory: string | undefined;
afterEach(() => {
  vi.unstubAllEnvs();
  if (directory) fs.rmSync(directory, { recursive: true, force: true });
});
function setup() {
  directory = fs.mkdtempSync(path.join(tmpdir(), "deleted-conversations-"));
  vi.stubEnv("ELIZA_STATE_DIR", directory);
  vi.stubEnv("ELIZA_CONFIG_PATH", path.join(directory, "config.json"));
  return path.join(directory, "deleted-conversations.v1.json");
}
it("reopens committed state and ignores an interrupted unpublished replacement", () => {
  const file = setup();
  expect(readDeletedConversationIdsFromState().size).toBe(0);
  persistDeletedConversationIdsToState(new Set(["first", "second"]));
  fs.writeFileSync(`${file}.tmp.interrupted`, '{"version":1,');
  expect([...readDeletedConversationIdsFromState()]).toEqual([
    "first",
    "second",
  ]);
  persistDeletedConversationIdsToState(new Set(["third"]));
  expect([...readDeletedConversationIdsFromState()]).toEqual(["third"]);
  expect(fs.statSync(file).mode & 0o777).toBe(0o600);
});
it.each(["{", "null", '{"version":2,"ids":[]}', '{"version":1,"ids":[null]}'])(
  "rejects corrupt state before starting a host (%s)",
  async (bytes) => {
    const file = setup();
    fs.writeFileSync(file, bytes);
    await expect(
      startApiServer({ port: 0, skipDeferredStartupWork: true }),
    ).rejects.toMatchObject({ code: "DELETED_CONVERSATION_STATE_READ_FAILED" });
    expect(fs.readFileSync(file, "utf8")).toBe(bytes);
  },
);
it("reports failed publication and permits retry without leftover temp files", () => {
  const file = setup();
  fs.mkdirSync(file);
  expect(() =>
    persistDeletedConversationIdsToState(new Set(["retry"])),
  ).toThrow(
    expect.objectContaining({
      code: "DELETED_CONVERSATION_STATE_WRITE_FAILED",
    }),
  );
  fs.rmdirSync(file);
  persistDeletedConversationIdsToState(new Set(["retry"]));
  expect([...readDeletedConversationIdsFromState()]).toEqual(["retry"]);
  expect(fs.readdirSync(path.dirname(file))).toEqual([path.basename(file)]);
});

it("retries a failed HTTP tombstone commit and preserves deletion across host restart", async () => {
  const file = setup();
  vi.stubEnv("ELIZA_API_BIND_HOST", "127.0.0.1");
  vi.stubEnv("ELIZA_API_TOKEN", "");
  vi.stubEnv("ELIZA_REQUIRE_LOCAL_AUTH", "0");
  const runtime = new AgentRuntime({
    character: { name: "Tombstone host", bio: [] },
    logLevel: "fatal",
    enableAutonomy: false,
  });
  runtime.registerDatabaseAdapter(
    SQLiteDatabaseAdapter.create(
      path.join(path.dirname(file), "state.sqlite"),
      runtime.agentId,
    ),
  );
  await runtime.init();
  let server = await startApiServer({
    port: 0,
    runtime,
    skipDeferredStartupWork: true,
  });
  const id = "a6062520-f881-446a-9e29-cd8e6000c891";
  try {
    fs.mkdirSync(file);
    const first = await fetch(
      `http://127.0.0.1:${server.port}/api/conversations/${id}`,
      { method: "DELETE" },
    );
    expect(first.status).toBe(500);
    await first.text();
    fs.rmdirSync(file);
    const retry = await fetch(
      `http://127.0.0.1:${server.port}/api/conversations/${id}`,
      { method: "DELETE" },
    );
    expect(retry.status).toBe(200);
    await retry.text();
    expect(readDeletedConversationIdsFromState().has(id)).toBe(true);
    await server.close();
    server = await startApiServer({
      port: 0,
      runtime,
      skipDeferredStartupWork: true,
    });
    const response = await fetch(
      `http://127.0.0.1:${server.port}/api/conversations/${id}/messages`,
    );
    expect(response.status).toBe(404);
    await response.text();
  } finally {
    await server.close();
    await runtime.close();
  }
});
