import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { resolveNativeLibraryCandidate } from "./native-platform.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

it("confines store libraries to the executable's bundle, including symlink targets", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "eliza-native-policy-"));
  roots.push(root);
  const bundle = path.join(root, "Eliza.app");
  const inside = path.join(bundle, "Contents", "Frameworks", "bridge.dylib");
  const outside = path.join(root, "Other.app", "Contents", "bridge.dylib");
  for (const file of [inside, outside]) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "fixture");
  }
  const opts = {
    env: { ELIZA_BUILD_VARIANT: "store" },
    execPath: path.join(bundle, "Contents", "MacOS", "Eliza"),
    moduleDir: path.dirname(outside),
    expectedBasename: "bridge.dylib",
  };
  expect(resolveNativeLibraryCandidate({ path: inside }, opts)).toBe(
    realpathSync(inside),
  );
  expect(resolveNativeLibraryCandidate({ path: outside }, opts)).toBeNull();
  rmSync(inside);
  symlinkSync(outside, inside);
  expect(resolveNativeLibraryCandidate({ path: inside }, opts)).toBeNull();
  expect(
    resolveNativeLibraryCandidate(
      { path: inside },
      { ...opts, env: { ELIZA_BUILD_VARIANT: "direct" } },
    ),
  ).toBe(realpathSync(outside));
});
