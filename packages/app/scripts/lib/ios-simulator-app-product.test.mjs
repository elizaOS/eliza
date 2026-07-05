import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  findLatestBuiltIosSimulatorApp,
  selectLatestIosSimulatorAppProduct,
} from "./ios-simulator-app-product.mjs";

const tmpDirs = [];

function makeTmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-ios-app-product-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { force: true, recursive: true });
  }
});

describe("iOS simulator app product discovery", () => {
  it("selects the newest App.app deterministically", () => {
    expect(
      selectLatestIosSimulatorAppProduct([
        { path: "/tmp/older/App.app", mtimeMs: 100 },
        { path: "/tmp/newer/App.app", mtimeMs: 200 },
        { path: "/tmp/invalid/App.app", mtimeMs: Number.NaN },
      ]),
    ).toBe("/tmp/newer/App.app");
  });

  it("uses path order as a stable tie-breaker", () => {
    expect(
      selectLatestIosSimulatorAppProduct([
        { path: "/tmp/z/App.app", mtimeMs: 200 },
        { path: "/tmp/a/App.app", mtimeMs: 200 },
      ]),
    ).toBe("/tmp/a/App.app");
  });

  it("returns null when DerivedData is absent", () => {
    expect(
      findLatestBuiltIosSimulatorApp({
        derivedData: path.join(makeTmpDir(), "missing"),
      }),
    ).toBeNull();
  });

  it("finds the newest Debug-iphonesimulator product from find output", () => {
    const root = makeTmpDir();
    const older = path.join(
      root,
      "A/Build/Products/Debug-iphonesimulator/App.app",
    );
    const newer = path.join(
      root,
      "B/Build/Products/Debug-iphonesimulator/App.app",
    );
    fs.mkdirSync(older, { recursive: true });
    fs.mkdirSync(newer, { recursive: true });

    const fsImpl = {
      existsSync: () => true,
      statSync: (target) => ({
        mtimeMs: target === newer ? 300 : 100,
      }),
    };
    const execFileSyncImpl = () => `${older}\n${newer}\n`;

    expect(
      findLatestBuiltIosSimulatorApp({
        derivedData: root,
        fsImpl,
        execFileSyncImpl,
      }),
    ).toBe(newer);
  });
});
