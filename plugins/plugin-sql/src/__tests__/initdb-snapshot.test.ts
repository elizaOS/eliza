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
    expect(
      initdbSnapshotPath(options({ dataDir: "memory://" }), {}, bundleUrl),
    ).toBe(`/data/app/bundle/${INITDB_SNAPSHOT_FILE}`);
    expect(initdbSnapshotPath(options({}), {}, bundleUrl)).toBe(
      `/data/app/bundle/${INITDB_SNAPSHOT_FILE}`,
    );
  });

  it("leaves on-disk databases and explicit loadDataDir alone", () => {
    expect(
      initdbSnapshotPath(options({ dataDir: "/data/db" }), {}, bundleUrl),
    ).toBeNull();
    expect(
      initdbSnapshotPath(
        options({ dataDir: "memory://", loadDataDir: new Blob([]) }),
        {},
        bundleUrl,
      ),
    ).toBeNull();
  });

  it("takes an absolute PGLITE_INITDB_SNAPSHOT and refuses a relative one", () => {
    expect(
      initdbSnapshotPath(
        options({ dataDir: "memory://" }),
        { PGLITE_INITDB_SNAPSHOT: "/opt/snap.bin" },
        bundleUrl,
      ),
    ).toBe("/opt/snap.bin");
    expect(
      initdbSnapshotPath(
        options({ dataDir: "memory://" }),
        { PGLITE_INITDB_SNAPSHOT: "snap.bin" },
        bundleUrl,
      ),
    ).toBeNull();
  });
});

describe("readInitdbSnapshot", () => {
  const gzip = new Uint8Array([0x1f, 0x8b, 8, 0, 0, 0]);
  for (const Backing of [ArrayBuffer, SharedArrayBuffer]) {
    it(`keeps a snapshot view complete and immutable with ${Backing.name}`, async () => {
      const backing = new Uint8Array(new Backing(gzip.length + 6));
      backing.fill(0xa5);
      backing.set(gzip, 3);
      const view = backing.subarray(3, 3 + gzip.length);
      const blob = readInitdbSnapshot(
        "/snap",
        () => view,
        () => view.byteLength,
      );
      if (!blob) throw new Error("Expected a snapshot blob");
      expect(blob.type).toBe("application/x-gzip");
      expect(new Uint8Array(await blob.arrayBuffer())).toEqual(gzip);
      backing.fill(0);
      expect(new Uint8Array(await blob.arrayBuffer())).toEqual(gzip);
    });
  }

  it("returns null when absent, oversized or not gzip", () => {
    expect(readInitdbSnapshot(null)).toBeNull();
    expect(
      readInitdbSnapshot(
        "/missing",
        () => gzip,
        () => null,
      ),
    ).toBeNull();
    expect(
      readInitdbSnapshot(
        "/big",
        () => gzip,
        () => MAX_INITDB_SNAPSHOT_BYTES + 1,
      ),
    ).toBeNull();
    expect(
      readInitdbSnapshot(
        "/text",
        () => new Uint8Array([0x7b, 0x7d]),
        () => 2,
      ),
    ).toBeNull();
    const grown = new Uint8Array(MAX_INITDB_SNAPSHOT_BYTES + 1);
    grown.set(gzip);
    expect(
      readInitdbSnapshot(
        "/grown",
        () => grown,
        () => gzip.length,
      ),
    ).toBeNull();
  });
});
