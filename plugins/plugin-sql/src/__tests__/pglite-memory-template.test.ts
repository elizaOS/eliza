/**
 * An in-memory PGlite database starts from a verified packaged template instead of running initdb,
 * and any template that does not match its stamp is ignored (PGlite reports an unreadable template
 * as an unhandled rejection, so it must never reach PGlite).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PGliteClientManager } from "../pglite/manager";
import {
  PGLITE_TEMPLATE_FILE,
  PGLITE_TEMPLATE_STAMP,
  pgliteTemplateStamp,
  readPgliteMemoryTemplate,
} from "../pglite/memory-template";

let template: Uint8Array;
const directories: string[] = [];

function templateDirectory(bytes: Uint8Array, stamp: unknown): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pglite-template-"));
  directories.push(directory);
  fs.writeFileSync(path.join(directory, PGLITE_TEMPLATE_FILE), bytes);
  fs.writeFileSync(path.join(directory, PGLITE_TEMPLATE_STAMP), JSON.stringify(stamp));
  return directory;
}

beforeAll(async () => {
  const fresh = await PGlite.create({ dataDir: "memory://" });
  template = new Uint8Array(await (await fresh.dumpDataDir("gzip")).arrayBuffer());
  await fresh.close();
}, 120_000);

afterEach(() => {
  delete process.env.ELIZA_PGLITE_TEMPLATE_DIR;
  delete process.env.ELIZA_PGLITE_TEMPLATE;
});

afterAll(() => {
  for (const directory of directories) fs.rmSync(directory, { recursive: true, force: true });
});

describe("PGlite memory template", () => {
  it("reads a template that matches its stamp", () => {
    const directory = templateDirectory(template, pgliteTemplateStamp(template, "test"));
    expect(readPgliteMemoryTemplate(directory)?.byteLength).toBe(template.byteLength);
  });

  it("ignores a template whose size, checksum or format differs from its stamp", () => {
    const stamp = pgliteTemplateStamp(template, "test");
    expect(
      readPgliteMemoryTemplate(templateDirectory(template, { ...stamp, bytes: stamp.bytes + 1 }))
    ).toBeNull();
    expect(
      readPgliteMemoryTemplate(templateDirectory(template, { ...stamp, sha256: "0".repeat(64) }))
    ).toBeNull();
    expect(
      readPgliteMemoryTemplate(templateDirectory(template, { ...stamp, format: 2 }))
    ).toBeNull();
    const corrupt = new Uint8Array(1000);
    expect(
      readPgliteMemoryTemplate(
        templateDirectory(corrupt, { ...pgliteTemplateStamp(template, "test"), bytes: 1000 })
      )
    ).toBeNull();
  });

  it("is off with ELIZA_PGLITE_TEMPLATE=0 and absent without files", () => {
    const directory = templateDirectory(template, pgliteTemplateStamp(template, "test"));
    process.env.ELIZA_PGLITE_TEMPLATE = "0";
    expect(readPgliteMemoryTemplate(directory)).toBeNull();
    delete process.env.ELIZA_PGLITE_TEMPLATE;
    expect(
      readPgliteMemoryTemplate(fs.mkdtempSync(path.join(os.tmpdir(), "pglite-empty-")))
    ).toBeNull();
  });

  it("starts an in-memory manager from the template and runs queries", async () => {
    process.env.ELIZA_PGLITE_TEMPLATE_DIR = templateDirectory(
      template,
      pgliteTemplateStamp(template, "test")
    );
    const manager = new PGliteClientManager({ dataDir: "memory://" });
    try {
      const db = manager.getConnection();
      await db.waitReady;
      await db.exec(
        "CREATE EXTENSION IF NOT EXISTS vector; CREATE TABLE t (id serial primary key, v text); INSERT INTO t (v) VALUES ('a');"
      );
      expect((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM t")).rows[0].n).toBe(1);
    } finally {
      await manager.close();
    }
  }, 120_000);

  it("keeps the initdb path for a template that does not match", async () => {
    const stamp = pgliteTemplateStamp(template, "test");
    process.env.ELIZA_PGLITE_TEMPLATE_DIR = templateDirectory(new Uint8Array(stamp.bytes), stamp);
    const manager = new PGliteClientManager({ dataDir: "memory://" });
    try {
      const db = manager.getConnection();
      await db.waitReady;
      expect((await db.query<{ one: number }>("SELECT 1 AS one")).rows[0].one).toBe(1);
    } finally {
      await manager.close();
    }
  }, 120_000);
});
