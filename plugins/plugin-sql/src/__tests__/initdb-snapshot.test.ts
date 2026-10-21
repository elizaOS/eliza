import { gunzipSync, gzipSync } from "node:zlib";
import type { PGliteOptions } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import {
  INITDB_SNAPSHOT_FILE,
  initdbSnapshotPath,
  MAX_INITDB_SNAPSHOT_BYTES,
  readInitdbSnapshot,
} from "../pglite/initdb-snapshot";

const bundleUrl = "file:///data/app/bundle/agent-bundle.js";
const options = (value: Record<string, unknown>) => value as PGliteOptions;

describe("initdbSnapshotPath", () => {
  it("uses the file beside the bundle for an in-memory database", () => {
    expect(initdbSnapshotPath(options({ dataDir: "memory://" }), {}, bundleUrl)).toBe(
      `/data/app/bundle/${INITDB_SNAPSHOT_FILE}`
    );
    expect(initdbSnapshotPath(options({}), {}, bundleUrl)).toBe(
      `/data/app/bundle/${INITDB_SNAPSHOT_FILE}`
    );
  });

  it("leaves on-disk databases and explicit loadDataDir alone", () => {
    expect(initdbSnapshotPath(options({ dataDir: "/data/db" }), {}, bundleUrl)).toBeNull();
    expect(
      initdbSnapshotPath(
        options({ dataDir: "memory://", loadDataDir: new Blob([]) }),
        {},
        bundleUrl
      )
    ).toBeNull();
  });

  it("takes an absolute PGLITE_INITDB_SNAPSHOT and refuses a relative one", () => {
    expect(
      initdbSnapshotPath(
        options({ dataDir: "memory://" }),
        { PGLITE_INITDB_SNAPSHOT: "/opt/snap.bin" },
        bundleUrl
      )
    ).toBe("/opt/snap.bin");
    expect(
      initdbSnapshotPath(
        options({ dataDir: "memory://" }),
        { PGLITE_INITDB_SNAPSHOT: "snap.bin" },
        bundleUrl
      )
    ).toBeNull();
  });
});

describe("readInitdbSnapshot", () => {
  const gzip = new Uint8Array([0x1f, 0x8b, 8, 0, 0, 0]);
  it("returns a gzip blob for a present snapshot", async () => {
    const blob = readInitdbSnapshot(
      "/snap",
      () => gzip,
      () => gzip.length
    );
    expect(blob).not.toBeNull();
    expect(new Uint8Array(await (blob as Blob).arrayBuffer())).toEqual(gzip);
  });

  it("preserves only the gzip view bytes from a shared backing buffer", async () => {
    const payload = Buffer.from("snapshot contents with no surrounding bytes");
    const compressed = gzipSync(payload);
    const backing = new Uint8Array(new SharedArrayBuffer(compressed.length + 8));
    backing.fill(0xff);
    backing.set(compressed, 4);
    const view = backing.subarray(4, 4 + compressed.length);
    const blob = readInitdbSnapshot(
      "/snap",
      () => view,
      () => view.length
    );
    expect(blob).not.toBeNull();
    if (!blob) throw new Error("Expected a snapshot blob");
    backing.fill(0);
    const saved = new Uint8Array(await blob.arrayBuffer());
    expect(saved).toEqual(new Uint8Array(compressed));
    expect(blob.type).toBe("application/x-gzip");
    expect(gunzipSync(saved)).toEqual(payload);
  });

  it("returns null when absent, oversized or not gzip", () => {
    expect(readInitdbSnapshot(null)).toBeNull();
    expect(
      readInitdbSnapshot(
        "/missing",
        () => gzip,
        () => null
      )
    ).toBeNull();
    expect(
      readInitdbSnapshot(
        "/big",
        () => gzip,
        () => MAX_INITDB_SNAPSHOT_BYTES + 1
      )
    ).toBeNull();
    expect(
      readInitdbSnapshot(
        "/text",
        () => new Uint8Array([0x7b, 0x7d]),
        () => 2
      )
    ).toBeNull();
  });
});
