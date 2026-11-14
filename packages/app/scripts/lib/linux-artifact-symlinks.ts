/** Keeps copied Linux package payload symlinks contained and relocatable. */
import {
  existsSync,
  lstatSync,
  readdirSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";

export function normalizeAbsoluteStagedSymlinks(sourceRoot, destinationRoot) {
  const pending = [sourceRoot];
  while (pending.length > 0) {
    const sourcePath = pending.pop();
    if (!sourcePath) continue;
    const stats = lstatSync(sourcePath);
    if (stats.isDirectory()) {
      for (const entry of readdirSync(sourcePath)) {
        pending.push(path.join(sourcePath, entry));
      }
      continue;
    }
    if (!stats.isSymbolicLink()) continue;

    const target = readlinkSync(sourcePath);
    const resolvedTarget = path.resolve(path.dirname(sourcePath), target);
    const sourceRelativeTarget = path.relative(sourceRoot, resolvedTarget);
    if (
      sourceRelativeTarget === ".." ||
      sourceRelativeTarget.startsWith(`..${path.sep}`) ||
      path.isAbsolute(sourceRelativeTarget)
    ) {
      throw new Error(
        `Linux package payload contains an escaping symlink: ${sourcePath} -> ${target}`,
      );
    }
    if (!existsSync(resolvedTarget)) {
      throw new Error(
        `Linux package payload contains a dangling symlink: ${sourcePath} -> ${target}`,
      );
    }
    if (!path.isAbsolute(target)) continue;

    const stagedLink = path.join(
      destinationRoot,
      path.relative(sourceRoot, sourcePath),
    );
    const stagedTarget = path.join(destinationRoot, sourceRelativeTarget);
    unlinkSync(stagedLink);
    symlinkSync(
      path.relative(path.dirname(stagedLink), stagedTarget),
      stagedLink,
    );
  }
}
