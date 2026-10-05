import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { resolveElizaPackageRootSync } from "./eliza-root";

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "eliza-root-"));
  roots.push(root);
  const app = join(root, "packages", "app");
  mkdirSync(app, { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "eliza" }));
  writeFileSync(
    join(app, "package.json"),
    JSON.stringify({ name: "@elizaos/app" }),
  );
  return { root, app };
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
describe("host workspace discovery", () => {
  it("finds the workspace from source, launcher and working directory", () => {
    const { root, app } = fixture();
    expect(resolveElizaPackageRootSync({ cwd: app })).toBe(root);
    expect(
      resolveElizaPackageRootSync({ argv1: join(app, "bin", "eliza") }),
    ).toBe(root);
    expect(
      resolveElizaPackageRootSync({
        moduleUrl: pathToFileURL(join(app, "src", "main.ts")).href,
      }),
    ).toBe(root);
  });
  it("does not treat an installed app package as a workspace", () => {
    const { root, app } = fixture();
    rmSync(join(root, "package.json"));
    expect(resolveElizaPackageRootSync({ cwd: app })).toBeNull();
  });
  it("surfaces invalid package metadata instead of selecting a different ancestor", () => {
    const { app } = fixture();
    writeFileSync(join(app, "package.json"), "{");
    expect(() => resolveElizaPackageRootSync({ cwd: app })).toThrow(
      SyntaxError,
    );
  });
});
