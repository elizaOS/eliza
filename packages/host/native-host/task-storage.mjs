import { chmod, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { NativeHostError } from "./errors.mjs";

const unavailable = () =>
  new NativeHostError("Required task database storage is unavailable", {
    code: "TASK_STORAGE_UNAVAILABLE",
  });
/** Host-only admission. The trusted provider owns key custody and driver-specific
 * verification. No renderer flag/key can enable it. No migration or encrypted-to-
 * plaintext fallback. Outcome/evidence/diagnostic files require separate custody. */
export async function openTaskDatabase({
  databasePath,
  requireEncryption = false,
  databaseProvider,
} = {}) {
  if (
    typeof databasePath !== "string" ||
    !databasePath ||
    typeof requireEncryption !== "boolean"
  )
    throw unavailable();
  // Keep the legacy host-relative path contract; providers receive one stable path.
  databasePath = resolve(databasePath);
  // Before even creating a directory: incomplete encrypted configuration writes nothing.
  if (
    requireEncryption &&
    (!databaseProvider ||
      typeof databaseProvider.open !== "function" ||
      typeof databaseProvider.assertEncryption !== "function")
  )
    throw unavailable();
  if (
    databaseProvider !== undefined &&
    (!databaseProvider || typeof databaseProvider.open !== "function")
  )
    throw unavailable();
  let db;
  try {
    await mkdir(dirname(databasePath), { recursive: true, mode: 0o700 });
    db = databaseProvider
      ? await databaseProvider.open({ path: databasePath })
      : process.versions.bun
        ? new (await import("bun:sqlite")).Database(databasePath, {
            create: true,
          })
        : new (await import("node:sqlite")).DatabaseSync(databasePath);
    if (
      !db ||
      ["exec", "prepare", "close"].some(
        (name) => typeof db[name] !== "function",
      )
    )
      throw unavailable();
    // Explicit acknowledgement after checking the active key, driver and file/WAL
    // policy; an advertised capability alone does not satisfy this host contract.
    if (
      requireEncryption &&
      (await databaseProvider.assertEncryption({ db, path: databasePath })) !==
        true
    )
      throw unavailable();
    await chmod(databasePath, 0o600);
    db.exec("PRAGMA synchronous = FULL");
    return db;
  } catch {
    try {
      db?.close();
    } catch {
      /* Preserve the fixed admission failure. */
    }
    throw unavailable();
  }
}
