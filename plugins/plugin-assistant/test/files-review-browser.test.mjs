/** Real Chromium IndexedDB + shared coordinator. Host approval/journal ports are fixtures. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { after, before, test } from "node:test";
import { chromium } from "playwright";
import { testOutputPath } from "../../../packages/scripts/lib/test-output.ts";

const root = path.resolve(import.meta.dirname, "../../..");
let browser;
let server;
let origin;
let bundle;
before(async () => {
  const outputRoot = testOutputPath("quint-files-review");
  await mkdir(outputRoot, { recursive: true });
  const directory = await mkdtemp(path.join(outputRoot, "browser-"));
  const output = path.join(directory, "entry.js");
  const built = spawnSync(
    "bun",
    [
      "build",
      "--target=browser",
      "--conditions=eliza-source",
      path.join(root, "plugins/plugin-assistant/test/files-review/browser.ts"),
      "--outfile",
      output,
    ],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(built.status, 0, built.stderr);
  bundle = await readFile(output);
  server = createServer((req, res) => {
    res.setHeader(
      "content-type",
      req.url === "/entry.js" ? "text/javascript" : "text/html",
    );
    res.end(
      req.url === "/entry.js"
        ? bundle
        : "<!doctype html><title>Files review conformance</title>",
    );
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.ELIZA_UI_SMOKE_CHROMIUM_EXECUTABLE || undefined,
  });
  console.log(`Chromium ${browser.version()}`);
});
after(async () => {
  await browser?.close();
  if (server) await new Promise((resolve) => server.close(resolve));
});

async function run(scenario) {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(origin);
    return await page.evaluate(async (scenario) => {
      const { runFilesReviewScenario } = await import("/entry.js");
      return runFilesReviewScenario(scenario);
    }, scenario);
  } finally {
    await context.close();
  }
}

test("refresh keeps the first reviewed file identity after path replacement", async () => {
  const result = await run("refresh");
  assert.equal(result.cards, 1);
  assert.equal(result.identityCalls, 1);
  assert.deepEqual(result.executedIdentities, [result.originalIdentity]);
  assert.equal(result.sourceBytes, "replacement bytes");
  assert.equal(result.movedBytes, null);
  assert.equal(result.outcomes[0].status, "changed");
  assert.equal(result.journalPhase, "terminal");
});

test("an older empty listing cannot erase the newer review's file identity", async () => {
  const result = await run("old-list");
  assert.equal(result.sourceBytes, "replacement bytes", JSON.stringify(result));
  assert.equal(result.movedBytes, null);
  assert.equal(result.staleOutcome, "AbortError");
  assert.equal(result.identityCalls, 1);
  assert.deepEqual(result.executedIdentities, [result.originalIdentity]);
});

test("an older identity read cannot replace a newer review context", async () => {
  const result = await run("old-identities");
  assert.equal(result.staleOutcome, "AbortError", JSON.stringify(result));
  assert.equal(result.approvalError, undefined);
  assert.equal(result.sourceBytes, null);
  assert.equal(result.movedBytes, "original bytes");
});

test("a cancelled identity read never pins files the owner did not review", async () => {
  const result = await run("cancelled-identities");
  assert.equal(result.staleOutcome, "AbortError");
  assert.equal(result.identityCalls, 2);
  assert.notDeepEqual(result.executedIdentities, [result.originalIdentity]);
  assert.equal(result.sourceBytes, null);
  assert.equal(result.movedBytes, "replacement bytes");
});
