/** Export only committed source bytes; dirty checkout files never enter a bundle. */

import { execFileSync } from "node:child_process";
import fs from "node:fs";

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
