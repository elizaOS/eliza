/**
 * Seed for in-memory (`memory://`) PGlite databases.
 *
 * With no existing cluster, PGlite 0.4 runs initdb on every start: it creates a second PGlite
 * instance plus the initdb module, dumps the new cluster and copies it in. The closed instance's
 * WebAssembly memory stays reachable afterwards, so an in-memory agent pays initdb's time on every
 * boot and keeps roughly twice the PGlite memory it needs (on the host: about 1,070 MB RSS against
 * 525 MB, and 780 ms against 200 ms to the first query). A packaged build can ship an empty cluster
 * made by the same PGlite (`pglite-template.tar.gz`) and start from it with `loadDataDir` instead.
 *
 * PGlite reports a template it cannot read as an unhandled rejection, which ends the process, so
 * the template is used only when its stamp (`pglite-template.json`, written with it) matches its
 * size and SHA-256 exactly. Anything else keeps the initdb path.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "@elizaos/core";

export const PGLITE_TEMPLATE_FILE = "pglite-template.tar.gz";
export const PGLITE_TEMPLATE_STAMP = "pglite-template.json";
/** Largest template accepted (an empty PostgreSQL 17 cluster is about 4 MB gzipped). */
const MAX_TEMPLATE_BYTES = 64 * 1024 * 1024;

export interface PgliteTemplateStamp {
  format: 1;
  /** The @electric-sql/pglite version that made the cluster. */
  pglite: string;
  bytes: number;
  sha256: string;
}

/** Where a packaged build puts the template: `ELIZA_PGLITE_TEMPLATE_DIR`, else next to this module. */
export function defaultTemplateDirectory(): string | null {
  const configured = process.env.ELIZA_PGLITE_TEMPLATE_DIR?.trim();
  if (configured) return configured;
  try {
    const here = import.meta.url;
    return here.startsWith("file:") ? path.dirname(fileURLToPath(here)) : null;
  } catch {
    // error-policy:J6 a module without a file URL (a browser or test bundle) has no packaged template.
    return null;
  }
}

/** The verified template bytes, or null when there is none, it is disabled or it does not match its stamp. */
export function readPgliteMemoryTemplate(
  directory = defaultTemplateDirectory()
): Uint8Array<ArrayBuffer> | null {
  if (process.env.ELIZA_PGLITE_TEMPLATE === "0" || !directory) return null;
  const file = path.join(directory, PGLITE_TEMPLATE_FILE);
  const stampFile = path.join(directory, PGLITE_TEMPLATE_STAMP);
  if (!existsSync(file) || !existsSync(stampFile)) return null;
  try {
    const stamp = JSON.parse(readFileSync(stampFile, "utf8")) as Partial<PgliteTemplateStamp>;
    const size = statSync(file).size;
    if (
      stamp.format !== 1 ||
      typeof stamp.sha256 !== "string" ||
      stamp.bytes !== size ||
      size <= 0 ||
      size > MAX_TEMPLATE_BYTES
    ) {
      logger.warn(
        { src: "plugin:sql", file },
        "PGlite template does not match its stamp; running initdb"
      );
      return null;
    }
    const bytes = readFileSync(file);
    if (createHash("sha256").update(bytes).digest("hex") !== stamp.sha256) {
      logger.warn({ src: "plugin:sql", file }, "PGlite template checksum mismatch; running initdb");
      return null;
    }
    return new Uint8Array(bytes);
  } catch (error) {
    // error-policy:J6 an unreadable template only costs the initdb it would have saved.
    logger.warn(
      { src: "plugin:sql", file, error: String(error) },
      "PGlite template unreadable; running initdb"
    );
    return null;
  }
}

/** The stamp for a template: a fresh, empty cluster dumped with `dumpDataDir("gzip")` by PGlite `pglite`. */
export function pgliteTemplateStamp(bytes: Uint8Array, pglite: string): PgliteTemplateStamp {
  return {
    format: 1,
    pglite,
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}
