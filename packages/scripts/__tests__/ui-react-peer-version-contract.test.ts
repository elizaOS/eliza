/**
 * Keeps the published UI package's paired React peers installable together and
 * aligned with the versions exercised by the root workspace.
 */

import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

interface PackageManifest {
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  resolutions?: Record<string, string>;
}

const REPOSITORY_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

const readManifest = async (path: string): Promise<PackageManifest> =>
  Bun.file(path).json();

test("@elizaos/ui publishes the React pair tested by the workspace", async () => {
  const root = await readManifest(`${REPOSITORY_ROOT}/package.json`);
  const ui = await readManifest(`${REPOSITORY_ROOT}/packages/ui/package.json`);
  const rootReact = root.resolutions?.react;
  const rootReactDom = root.resolutions?.["react-dom"];

  expect(rootReact).toBeDefined();
  expect(rootReactDom).toBe(rootReact);
  expect(ui.peerDependencies?.react).toBe(rootReact);
  expect(ui.peerDependencies?.["react-dom"]).toBe(rootReactDom);
  expect(ui.devDependencies?.react).toBe(rootReact);
  expect(ui.devDependencies?.["react-dom"]).toBe(rootReactDom);
});
