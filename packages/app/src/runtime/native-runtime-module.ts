/** Verify the existing admitted product module before evaluating its exports. */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ElizaError } from "@elizaos/core";

export async function loadNativeRuntimeModule(
  env: NodeJS.ProcessEnv,
): Promise<Record<string, unknown> | undefined> {
  const entry = env.ELIZA_NATIVE_GOOGLE_HOST_MODULE;
  if (!entry) return undefined;
  const root = env.ELIZA_SMTHRS_RUNTIME_DIR;
  const unavailable = (message: string) =>
    new ElizaError(message, {
      code: "NATIVE_RUNTIME_MODULE_UNAVAILABLE",
    });
  if (!root) throw unavailable("Native runtime resources are unavailable");
  const filename = path.resolve(entry);
  try {
    const canonicalRoot = fs.realpathSync(root);
    const relative = path.relative(canonicalRoot, filename);
    if (
      !relative ||
      relative.startsWith("..") ||
      path.isAbsolute(relative) ||
      !relative.endsWith(".mjs")
    )
      throw unavailable(
        "Native Google host module escaped its admitted resources",
      );
    for (let current = filename; ; current = path.dirname(current)) {
      if (fs.lstatSync(current).isSymbolicLink())
        throw unavailable("Native Google host resources contain a symlink");
      if (current === canonicalRoot) break;
    }
    const manifestFile = path.join(canonicalRoot, "manifest.json");
    const manifestStat = fs.lstatSync(manifestFile);
    if (
      !manifestStat.isFile() ||
      manifestStat.isSymbolicLink() ||
      manifestStat.size > 1024 * 1024
    )
      throw unavailable("Native Google host manifest is invalid");
    const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
    const stat = fs.lstatSync(filename);
    const expected = manifest.files?.[relative.split(path.sep).join("/")];
    if (
      manifest.version !== 1 ||
      !stat.isFile() ||
      stat.size > 8 * 1024 * 1024 ||
      !/^[a-f0-9]{64}$/.test(expected ?? "") ||
      createHash("sha256").update(fs.readFileSync(filename)).digest("hex") !==
        expected
    )
      throw unavailable(
        "Native Google host module differs from its admitted manifest",
      );
  } catch {
    throw unavailable("Native runtime module admission failed");
  }
  return await import(pathToFileURL(filename).href);
}
