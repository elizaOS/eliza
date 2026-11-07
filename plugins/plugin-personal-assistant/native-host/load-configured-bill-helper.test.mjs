import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfiguredBillHelper } from "./load-configured-bill-helper.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "helper loading "));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundlePath = join(root, "runtime module.mjs");
  await writeFile(bundlePath, 'export const identity="fixture-runtime";');
  await writeFile(
    `${bundlePath}.json`,
    JSON.stringify({ sourceCommit: "a".repeat(40) }),
  );
  const configurationPath = join(root, "helper.json");
  const configuration = {
    actorId: "owner",
    googleSource: { grantId: "grant", pdfModel: "model" },
  };
  await writeFile(configurationPath, JSON.stringify(configuration));
  const calls = [];
  return {
    calls,
    configuration,
    args: {
      configurationPath,
      bundlePath,
      documentPath: join(root, "documents.mjs"),
      evidenceDirectory: join(root, "evidence"),
      readConfiguration: async (file) =>
        JSON.parse(await readFile(file, "utf8")),
      loadDocumentRuntime: async (file, options) => {
        calls.push(["document", file, options]);
        return { identity: "documents" };
      },
      cloudHandler: {
        documentImagesForAccount: (options) => {
          calls.push(["images", options]);
          return "images";
        },
        googleForAccount: (options) => {
          calls.push(["google", options]);
          return "google";
        },
      },
      createHelper: (options) => {
        calls.push(["helper"]);
        return options;
      },
    },
  };
}

test("loads real module path with spaces and binds document source and selected account", async (t) => {
  const f = await fixture(t);
  const helper = await loadConfiguredBillHelper(f.args);
  assert.equal(helper.runtimeModule.identity, "fixture-runtime");
  assert.equal(helper.documentRuntime.identity, "documents");
  assert.equal(helper.documentImages, "images");
  assert.equal(helper.googleReadPort, "google");
  assert.deepEqual(f.calls[0], [
    "document",
    f.args.documentPath,
    { sourceCommit: "a".repeat(40) },
  ]);
  assert.deepEqual(f.calls[2], [
    "google",
    { actorId: "owner", accountId: "grant" },
  ]);
});

test("only explicit optional missing configuration is ignored", async (t) => {
  const f = await fixture(t);
  await rm(f.args.configurationPath);
  assert.equal(
    await loadConfiguredBillHelper({ ...f.args, optional: true }),
    undefined,
  );
  await assert.rejects(loadConfiguredBillHelper(f.args), { code: "ENOENT" });
  await writeFile(f.args.configurationPath, "{");
  await assert.rejects(
    loadConfiguredBillHelper({ ...f.args, optional: true }),
    SyntaxError,
  );
  assert.deepEqual(f.calls, []);
});

test("PDF loading fails closed on missing artifact selection, bad provenance and loader rejection", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    loadConfiguredBillHelper({ ...f.args, documentPath: undefined }),
    /reviewed document runtime/,
  );
  await writeFile(`${f.args.bundlePath}.json`, "{");
  await assert.rejects(loadConfiguredBillHelper(f.args), SyntaxError);
  await writeFile(
    `${f.args.bundlePath}.json`,
    JSON.stringify({ sourceCommit: "b".repeat(40) }),
  );
  await assert.rejects(
    loadConfiguredBillHelper({
      ...f.args,
      loadDocumentRuntime: async () => {
        throw new Error("provenance mismatch");
      },
    }),
    /provenance mismatch/,
  );
  assert.deepEqual(f.calls, []);
});
