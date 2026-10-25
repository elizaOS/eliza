import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

/** Resolve a configured helper and reviewed document runtime without implicit account selection. */
export async function loadConfiguredBillHelper({
  configurationPath,
  optional = false,
  bundlePath,
  documentPath,
  evidenceDirectory,
  readConfiguration,
  createHelper,
  loadDocumentRuntime,
  cloudHandler,
  credentialGate,
  onUnavailable,
}) {
  if (!configurationPath) return undefined;
  let configuration;
  try {
    configuration = await readConfiguration(configurationPath);
  } catch (error) {
    if (optional && error.code === "ENOENT") return undefined;
    throw error;
  }
  let documentRuntime, documentImages;
  if (configuration.googleSource?.pdfModel) {
    if (!documentPath)
      throw new Error(
        "Set the reviewed document runtime artifact for PDF discovery",
      );
    const provenance = JSON.parse(await readFile(`${bundlePath}.json`, "utf8"));
    documentRuntime = await loadDocumentRuntime(documentPath, {
      sourceCommit: provenance.sourceCommit,
    });
    documentImages = cloudHandler.documentImagesForAccount({
      actorId: configuration.actorId,
      model: configuration.googleSource.pdfModel,
      documentRuntime,
    });
  }
  return createHelper({
    configuration,
    documentRuntime,
    documentImages,
    googleReadPort: configuration.googleSource
      ? cloudHandler.googleForAccount({
          actorId: configuration.actorId,
          accountId: configuration.googleSource.grantId,
        })
      : undefined,
    runtimeModule: await import(pathToFileURL(bundlePath).href),
    credentialGate,
    evidenceDirectory,
    onUnavailable,
  });
}
