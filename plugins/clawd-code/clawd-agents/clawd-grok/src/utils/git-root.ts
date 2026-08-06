import fs from "fs";
import path from "path";

export function findGitRoot(start: string): string | null {
  let current = start;

  while (true) {
    const gitPath = path.join(current, ".git");
    if (fs.existsSync(gitPath)) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}
