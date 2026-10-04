import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NativeHostError } from "./errors.mjs";
export function buildDocumentRuntime(
  source,
  output,
  { sourceCommit, canvasVersion },
) {
  source = fs.realpathSync(source);
  output = path.resolve(output);
  const git = (args) =>
    execFileSync("git", args, {
      cwd: source,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    }).trim();

  if (fs.realpathSync(git(["rev-parse", "--show-toplevel"])) !== source)
    throw new NativeHostError("Document source must be the Git checkout root");
  const commit = git(["rev-parse", "HEAD"]);
  if (
    !/^[a-f0-9]{40}$/.test(sourceCommit) ||
    commit !== sourceCommit ||
    git(["status", "--porcelain", "--untracked-files=normal"])
  )
    throw new NativeHostError(
      "Document runtime requires the clean reviewed source commit",
    );
  const canvas = JSON.parse(
    fs.readFileSync(
      path.join(
        source,
        "plugins/plugin-pdf/node_modules/@napi-rs/canvas/package.json",
      ),
    ),
  ).version;
  const installedCanvas = canvasVersion;
  if (canvas !== installedCanvas)
    throw new NativeHostError(
      "Document canvas dependency does not match reviewed runtime",
    );
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), "eliza-document-build-"),
  );
  try {
    const entry = path.join(temporary, "entry.ts");
    fs.writeFileSync(
      entry,
      [
        `export {PdfService} from ${JSON.stringify(path.join(source, "plugins/plugin-pdf/index.ts"))};`,
        `export {handleImageDescription} from ${JSON.stringify(path.join(source, "plugins/plugin-elizacloud/src/models/image.ts"))};`,
        `export {resolveCloudSdkAuthorityTuple,getNativeApplicationSlot,getAppId} from ${JSON.stringify(path.join(source, "plugins/plugin-elizacloud/src/utils/config.ts"))};`,
      ].join("\n"),
    );
    fs.mkdirSync(path.dirname(output), { recursive: true });
    execFileSync(
      "bun",
      [
        "build",
        entry,
        "--target=node",
        "--conditions=eliza-source",
        "--external",
        "@napi-rs/canvas",
        "--outfile",
        output,
      ],
      { cwd: source, stdio: "pipe" },
    );
    const provenance = {
      schemaVersion: 1,
      sourceCommit: commit,
      bundleSha256: createHash("sha256")
        .update(fs.readFileSync(output))
        .digest("hex"),
      canvasVersion: canvas,
    };
    fs.writeFileSync(
      `${output}.json`,
      JSON.stringify(provenance, null, 2) + "\n",
    );
    return provenance;
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}
