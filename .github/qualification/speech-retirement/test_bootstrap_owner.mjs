/** Small owned module-layout fixtures; actual Node resolution, no npm entrypoint execution. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { inspectBootstrap } from "./bootstrap.mjs";

function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "eliza-bootstrap-owner-fixture-")));
  const root = path.join(base, "source");
  fs.mkdirSync(root);
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  function write(relative, value) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
    return file;
  }
  function packageAt(relative, name, version, extra = {}) {
    write(relative + "/package.json", { name, version, type: "module", main: "./index.js", ...extra });
    write(relative + "/index.js", "throw new Error('DEPENDENCY ENTRYPOINT MUST NOT EXECUTE');\n");
    return path.join(root, relative);
  }
  function link(relative, target) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.symlinkSync(target, file, "dir");
  }
  function edit(relative, change) {
    const file = path.join(root, relative);
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    change(value);
    fs.writeFileSync(file, JSON.stringify(value));
  }
  write("package.json", { name: "eliza", devDependencies: { vite: "8.3.3", vitest: "^5.0.5" } });
  write("packages/host/package.json", { name: "@elizaos/host", devDependencies: { vitest: "^5.0.5" } });
  write("packages/host/vitest.config.ts", "throw new Error('HOST CONFIG MUST NOT EXECUTE');\n");
  write("packages/cloud/api/package.json", { name: "@elizaos/cloud-api", devDependencies: { miniflare: "4.20260730.0" } });
  const vitest = "node_modules/.fixture-store/vitest";
  packageAt(vitest, "vitest", "5.0.5", { exports: { ".": "./index.js", "./node": "./node.js", "./config": "./config.js" } });
  for (const file of ["vitest.mjs", "node.js", "config.js"]) write(vitest + "/" + file, "throw new Error('VITEST MUST NOT EXECUTE');\n");
  packageAt("node_modules/.fixture-store/vite", "vite", "8.3.3");
  packageAt("node_modules/.fixture-store/miniflare", "miniflare", "4.20260730.0", { dependencies: { workerd: "1.20260730.1" } });
  packageAt("node_modules/.fixture-store/workerd", "workerd", "1.20260730.1");
  link("node_modules/vitest", ".fixture-store/vitest");
  link("node_modules/vite", ".fixture-store/vite");
  link("packages/host/node_modules/vitest", "../../../node_modules/.fixture-store/vitest");
  link("packages/cloud/api/node_modules/miniflare", "../../../../node_modules/.fixture-store/miniflare");
  link("node_modules/.fixture-store/miniflare/node_modules/workerd", "../../workerd");
  return { root, base, write, edit, link, packageAt };
}

test("root-absent API-only dependency resolves from its real owner without executing modules", t => {
  const f = fixture(t);
  assert.equal(fs.existsSync(path.join(f.root, "node_modules/miniflare")), false);
  assert.throws(() => createRequire(path.join(f.root, "package.json")).resolve("miniflare"));
  const result = inspectBootstrap(f.root);
  assert.equal(result.entries.length, 5);
  const miniflare = result.entries.find(x => x.name === "miniflare");
  const workerd = result.entries.find(x => x.name === "workerd");
  assert.equal(miniflare.importer, path.join(f.root, "packages/cloud/api/package.json"));
  assert.equal(miniflare.ownerName, "@elizaos/cloud-api");
  assert.equal(workerd.importer, miniflare.file);
  assert.equal(workerd.ownerManifest, miniflare.packageManifest);
  assert.equal(result.entries[1].ownerName, "@elizaos/host");
  assert.equal(result.entries[2].importer, path.join(f.root, "packages/host/vitest.config.ts"));
  assert(result.entries.every(x => /^[a-f0-9]{64}$/.test(x.sha256)));
});

test("missing API owner manifest cannot fall through to a different package context", t => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.root, "packages/cloud/api/package.json"));
  assert.throws(() => inspectBootstrap(f.root));
});

test("mismatched API owner identity fails even when its local dependency is installed", t => {
  const f = fixture(t);
  f.edit("packages/cloud/api/package.json", p => { p.name = "unrelated-owner"; });
  assert.throws(() => inspectBootstrap(f.root), /Wrong canonical bootstrap owner/);
});

test("undeclared API dependency is not admitted merely because Node can resolve it", t => {
  const f = fixture(t);
  f.edit("packages/cloud/api/package.json", p => { delete p.devDependencies.miniflare; });
  assert.throws(() => inspectBootstrap(f.root), /not declared by its canonical owner/);
});

test("absent API dependency fails rather than installing or inventing an alias", t => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.root, "packages/cloud/api/node_modules/miniflare"));
  assert.throws(() => inspectBootstrap(f.root));
});

test("resolved package name must match the canonical declared dependency", t => {
  const f = fixture(t);
  f.edit("node_modules/.fixture-store/miniflare/package.json", p => { p.name = "different-package"; });
  assert.throws(() => inspectBootstrap(f.root), /package identity mismatch/);
});

test("exact API version mismatch is rejected", t => {
  const f = fixture(t);
  f.edit("node_modules/.fixture-store/miniflare/package.json", p => { p.version = "0.0.1"; });
  assert.throws(() => inspectBootstrap(f.root), /exact version mismatch/);
});

test("canonical root Vitest CLI must exist despite a valid Host-local Vitest", t => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.root, "node_modules/vitest"));
  assert.throws(() => inspectBootstrap(f.root));
});

test("Host config dependency uses the real Host owner contract", t => {
  const f = fixture(t);
  f.edit("packages/host/package.json", p => { delete p.devDependencies.vitest; });
  assert.throws(() => inspectBootstrap(f.root), /not declared by its canonical owner/);
});

test("Vite shadowing from the Host context cannot contradict the root's exact declaration", t => {
  const f = fixture(t);
  f.packageAt("packages/host/node_modules/vite", "vite", "9.0.0");
  // Physical origin is deliberately kept in the admitted root store, as with Bun.
  fs.renameSync(path.join(f.root, "packages/host/node_modules/vite"), path.join(f.root, "node_modules/.fixture-store/wrong-vite"));
  f.link("packages/host/node_modules/vite", "../../../node_modules/.fixture-store/wrong-vite");
  assert.throws(() => inspectBootstrap(f.root), /exact version mismatch/);
});

test("Workerd declaration must belong to the resolved Miniflare package", t => {
  const f = fixture(t);
  f.edit("node_modules/.fixture-store/miniflare/package.json", p => { delete p.dependencies.workerd; });
  assert.throws(() => inspectBootstrap(f.root), /not declared by its canonical owner/);
});

test("transitive dependency escape outside the admitted source is rejected", t => {
  const f = fixture(t);
  const outside = path.join(f.base, "outside");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "package.json"), JSON.stringify({ name: "workerd", version: "1.20260730.1", main: "index.js" }));
  fs.writeFileSync(path.join(outside, "index.js"), "throw new Error('OUTSIDE MUST NOT EXECUTE');\n");
  const link = path.join(f.root, "node_modules/.fixture-store/miniflare/node_modules/workerd");
  fs.unlinkSync(link);
  fs.symlinkSync(outside, link, "dir");
  assert.throws(() => inspectBootstrap(f.root), /outside the admitted source/);
});
