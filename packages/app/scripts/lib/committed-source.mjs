/** Export only committed source bytes; dirty checkout files never enter a bundle. */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** @param {string} source
 * @param {string} commit
 * @param {string} destination
 * @param {string[]} paths
 */
export function exportCommittedSources(source, commit, destination, paths) {
  if (!/^[a-f0-9]{40}$/.test(commit))
    throw new Error("A full reviewed source commit is required");
  const checkout = execFileSync(
    "git",
    ["-C", source, "rev-parse", "--show-toplevel"],
    { encoding: "utf8" },
  ).trim();
  if (fs.realpathSync(checkout) !== fs.realpathSync(source))
    throw new Error("Source must be the Git checkout root");
  if (
    !Array.isArray(paths) ||
    !paths.length ||
    paths.some(
      (p) =>
        typeof p !== "string" ||
        p.startsWith("/") ||
        p.split("/").some((part) => !part || part === ".."),
    )
  )
    throw new Error("Explicit repository source paths are required");
  const archive = execFileSync(
    "git",
    ["-C", source, "archive", commit, "--", ...paths],
    { maxBuffer: 512 * 1024 * 1024 },
  );
  fs.mkdirSync(destination, { recursive: true });
  execFileSync("tar", ["-xf", "-", "-C", destination], {
    input: archive,
    maxBuffer: 16 * 1024 * 1024,
  });
  return commit;
}

export class ConsumerSourceError extends Error {
  /** @param {string} message @param {ErrorOptions} [options] */
  constructor(message, options) {
    super(message, options);
    this.name = "ConsumerSourceError";
  }
}

/** Admit and record a development checkout and runtime binary without launching the agent.
 * @param {{source:string,runtimeBinary?:string,expectedCommit?:string}} options
 */
export function inspectDevelopmentRuntime({
  source,
  runtimeBinary = "bun",
  expectedCommit,
}) {
  if (typeof source !== "string" || !path.isAbsolute(source))
    throw new ConsumerSourceError(
      "Set an absolute path to the reviewed Eliza checkout",
    );
  source = path.resolve(source);
  try {
    fs.readFileSync(path.join(source, "packages/agent/src/bin.ts"));
  } catch (cause) {
    throw new ConsumerSourceError(
      "Configured source does not contain the agent entrypoint",
      { cause },
    );
  }
  try {
    const checkout = execFileSync(
      "git",
      ["-C", source, "rev-parse", "--show-toplevel"],
      { encoding: "utf8" },
    ).trim();
    if (fs.realpathSync(checkout) !== fs.realpathSync(source))
      throw new ConsumerSourceError("Source must be the Git checkout root");
    const sourceCommit = execFileSync(
      "git",
      ["-C", source, "rev-parse", "HEAD"],
      { encoding: "utf8" },
    ).trim();
    if (!/^[a-f0-9]{40}$/.test(sourceCommit))
      throw new ConsumerSourceError("Source provenance is unavailable");
    if (expectedCommit && expectedCommit !== sourceCommit)
      throw new ConsumerSourceError(
        "Source differs from the configured commit",
      );
    const dirty = Boolean(
      execFileSync(
        "git",
        ["-C", source, "status", "--porcelain", "--untracked-files=normal"],
        { encoding: "utf8" },
      ).trim(),
    );
    if (expectedCommit && dirty)
      throw new ConsumerSourceError("Pinned source has local modifications");
    const bunVersion = execFileSync(runtimeBinary, ["--version"], {
      encoding: "utf8",
    }).trim();
    return { source, bun: runtimeBinary, sourceCommit, dirty, bunVersion };
  } catch (cause) {
    if (cause instanceof ConsumerSourceError) throw cause;
    throw new ConsumerSourceError(
      "Cannot inspect development runtime provenance",
      { cause },
    );
  }
}
