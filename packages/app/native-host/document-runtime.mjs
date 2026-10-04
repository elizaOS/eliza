import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { NativeHostError } from "./errors.mjs";
/** Host-owned artifact, built from reviewed source. Never accepts a renderer path. */
export async function loadDocumentRuntime(
  file,
  { sourceCommit, canvasVersion },
) {
  if (
    !path.isAbsolute(file) ||
    !/^[a-f0-9]{40}$/.test(sourceCommit) ||
    typeof canvasVersion !== "string"
  )
    throw new NativeHostError("Invalid document runtime configuration");
  const provenance = JSON.parse(await fs.readFile(`${file}.json`, "utf8"));
  const bytes = await fs.readFile(file);
  if (
    provenance.schemaVersion !== 1 ||
    provenance.sourceCommit !== sourceCommit ||
    provenance.canvasVersion !== canvasVersion ||
    provenance.bundleSha256 !== createHash("sha256").update(bytes).digest("hex")
  )
    throw new NativeHostError("Document runtime provenance mismatch");
  const runtime = await import(pathToFileURL(file).href);
  if (
    [
      "PdfService",
      "handleImageDescription",
      "resolveCloudSdkAuthorityTuple",
      "getNativeApplicationSlot",
      "getAppId",
    ].some((key) => typeof runtime[key] !== "function")
  )
    throw new NativeHostError("Incomplete document runtime");
  return runtime;
}
