/**
 * Disposable PGlite validation process; never a live Agent boot entry point.
 * It receives only a private copy path/inode via stdin and emits no database
 * rows or diagnostic text. The parent owns cancellation, reaping and cleanup.
 */

import { constants, fstatSync } from "node:fs";
import fs from "node:fs/promises";
import { Socket } from "node:net";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { fuzzystrmatch } from "@electric-sql/pglite/contrib/fuzzystrmatch";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { vector } from "@electric-sql/pglite/vector";

async function main(): Promise<void> {
  process.umask(0o077);
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    if (typeof chunk !== "string" || input.length + chunk.length > 4096)
      throw new Error("Invalid validation input");
    input += chunk;
  }
  const parsed: unknown = JSON.parse(input);
  input = "";
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Invalid validation input");
  const value = parsed as Record<string, unknown>;
  if (
    Object.keys(value).sort().join(",") !==
      "dataDirectory,device,inode,lockDevice,lockInode" ||
    typeof value.dataDirectory !== "string" ||
    !path.isAbsolute(value.dataDirectory) ||
    path.normalize(value.dataDirectory) !== value.dataDirectory ||
    typeof value.device !== "string" ||
    !/^(0|[1-9][0-9]*)$/.test(value.device) ||
    typeof value.inode !== "string" ||
    !/^[1-9][0-9]*$/.test(value.inode)
  )
    throw new Error("Invalid validation identity");
  const lockRoot = fstatSync(4, { bigint: true });
  if (
    !lockRoot.isDirectory() ||
    lockRoot.dev.toString() !== value.lockDevice ||
    lockRoot.ino.toString() !== value.lockInode
  )
    throw new Error("Validation lock identity mismatch");
  const dataDirectory = value.dataDirectory;
  const root = await fs.lstat(dataDirectory, { bigint: true });
  if (
    !root.isDirectory() ||
    (root.mode & 0o7777n) !== 0o700n ||
    root.dev.toString() !== value.device ||
    root.ino.toString() !== value.inode
  )
    throw new Error("Validation root changed");
  const version = await fs.open(
    path.join(dataDirectory, "PG_VERSION"),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  let major: string;
  try {
    const stat = await version.stat();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.size < 2 ||
      stat.size > 16 ||
      (stat.mode & 0o077) !== 0
    )
      throw new Error("Missing physical database");
    const bytes = Buffer.alloc(stat.size);
    try {
      const read = await version.read(bytes, 0, bytes.length, 0);
      const text = bytes.toString("utf8");
      if (read.bytesRead !== bytes.length || !/^[1-9][0-9]*\n$/.test(text))
        throw new Error("Invalid physical database version");
      major = text.trim();
    } finally {
      bytes.fill(0);
    }
  } finally {
    await version.close();
  }

  // No manager/bootstrap/migration hooks, credentials, Electric sync or network.
  // Match the runtime's bundled SQL extensions without enabling their writers.
  // The physical PG_VERSION was verified under the inherited quarantine lock.
  // noInitDb is not an open-existing flag in 0.4.6: it also skips engine startup.
  const database = new PGlite({
    dataDir: dataDirectory,
    extensions: { vector, fuzzystrmatch, pg_trgm },
  });
  let serverVersion: string;
  try {
    await database.waitReady;
    const query = await database.query<{ server_version: string }>(
      "SELECT current_setting('server_version_num') AS server_version",
    );
    const row = query.rows[0];
    if (
      query.rows.length !== 1 ||
      !row ||
      !/^[1-9][0-9]{4,5}$/.test(row.server_version) ||
      String(Math.floor(Number(row.server_version) / 10000)) !== major
    )
      throw new Error("Database server identity mismatch");
    serverVersion = row.server_version;
  } finally {
    await database.close();
  }
  const after = await fs.lstat(dataDirectory, { bigint: true });
  if (!after.isDirectory() || after.dev !== root.dev || after.ino !== root.ino)
    throw new Error("Validation root changed");
  process.stdout.write(
    JSON.stringify({
      version: 1,
      serverVersion,
      device: value.device,
      inode: value.inode,
    }),
  );
}

// Node supplies a pollable socketpair for this pipe. Do not use fs.ReadStream:
// a blocking thread-pool read cannot be cancelled when validation completes.
const parentLiveness = new Socket({ fd: 3, readable: true, writable: false });
parentLiveness.on("end", () => {
  process.kill(process.pid, "SIGKILL");
});
parentLiveness.on("error", () => {
  process.kill(process.pid, "SIGKILL");
});
parentLiveness.resume();
await main()
  .catch(() => {
    // error-policy:J1 Database diagnostics may contain private rows or settings.
    // The parent receives a failed process, never raw stderr or fabricated proof.
    process.exitCode = 1;
  })
  .finally(() => {
    parentLiveness.destroy();
  });
