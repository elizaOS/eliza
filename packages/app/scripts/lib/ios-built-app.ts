import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function latestBuiltApp(
  tryRun: (command: string, args: string[]) => string | null,
) {
  const derivedData = path.join(
    os.homedir(),
    "Library",
    "Developer",
    "Xcode",
    "DerivedData",
  );
  if (!fs.existsSync(derivedData)) return null;
  const output = tryRun("find", [
    derivedData,
    "-name",
    "App.app",
    "-path",
    "*/Debug-iphonesimulator/*",
    "-type",
    "d",
  ]);
  const apps = (output ?? "")
    .split("\n")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => ({ path: entry, mtimeMs: fs.statSync(entry).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return apps[0]?.path ?? null;
}

/** Frameworks are signed as units, so only return loose libraries. */
export function listNestedDylibs(root: string) {
  const dylibs: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) break;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.endsWith(".framework")) continue;
        stack.push(full);
      } else if (entry.name.endsWith(".dylib")) {
        dylibs.push(full);
      }
    }
  }
  return dylibs.sort();
}
