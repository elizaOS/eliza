/** Real Chromium isolated-world blocker reports on fixture pages; does not qualify arbitrary sites. */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { testOutputPath } from "../../../scripts/lib/test-output.ts";
import { blockerSelectors, pageCommand } from "../src/page-command.mjs";

const require = createRequire(
  import.meta.resolve("@elizaos/plugin-browser/package.json"),
);
const { default: puppeteer } = require("puppeteer-core");
if (!process.env.ELIZA_BROWSER_EXECUTABLE)
  throw new Error("Set ELIZA_BROWSER_EXECUTABLE to an installed test Chromium");
const fixtures = new URL("./fixtures/page-blockers/", import.meta.url);
const server = createServer(async (req, res) => {
  try {
    const name = new URL(req.url, "http://fixture").pathname.slice(1);
    if (!/^[a-z-]+\.html$/.test(name)) throw new Error("not a fixture");
    const body = await readFile(new URL(name, fixtures));
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(body);
  } catch {
    res.statusCode = 404;
    res.end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

// Expected report per fixture. A ref is named by its control's label here.
const expected = {
  "modal.html": [{ kind: "modal", covers: "viewport", ref: "Close" }],
  // A close control that also agrees to something is not a way out.
  "agreeing-close.html": [{ kind: "modal", covers: "viewport" }],
  "native-dialog.html": [{ kind: "modal", covers: "viewport", ref: "Not now" }],
  "cookie-banner.html": [
    { kind: "cookie-consent", covers: "partial", rejectRef: "Reject all" },
  ],
  "cookie-covers-target.html": [
    {
      kind: "cookie-consent",
      covers: "target",
      rejectRef: "Use necessary cookies only",
    },
  ],
  "captcha.html": [{ kind: "captcha", covers: "partial" }],
  "invisible-captcha.html": [],
  "interstitial.html": [{ kind: "captcha", covers: "viewport" }],
  "login-wall.html": [
    { kind: "login-wall", covers: "viewport", ref: "Not now" },
  ],
  "paywall.html": [{ kind: "paywall", covers: "partial" }],
  "clean.html": [],
  "app-shell.html": [],
};

let browser;
const cases = [];
try {
  browser = await puppeteer.launch({
    executablePath: process.env.ELIZA_BROWSER_EXECUTABLE,
    headless: true,
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 800, height: 600 });
  for (const [name, wanted] of Object.entries(expected)) {
    await page.goto(`http://127.0.0.1:${server.address().port}/${name}`);
    const cdp = await page.createCDPSession();
    const { frameTree } = await cdp.send("Page.getFrameTree");
    const { executionContextId } = await cdp.send("Page.createIsolatedWorld", {
      frameId: frameTree.frame.id,
      worldName: "eliza-page-blockers-test",
    });
    const result = await cdp.send("Runtime.evaluate", {
      contextId: executionContextId,
      expression: `(${pageCommand.toString()})({subaction:"snapshot"},"blockers-${name}")`,
      returnByValue: true,
    });
    await cdp.detach();
    assert.equal(
      result.exceptionDetails,
      undefined,
      JSON.stringify(result.exceptionDetails),
    );
    const snapshot = result.result.value;
    assert.equal(snapshot.complete, true, name);
    const labelOf = (id) =>
      id === undefined
        ? undefined
        : snapshot.elements.find((element) => element.id === id)?.label;
    const actual = snapshot.blockers.map(({ kind, covers, ref, rejectRef }) =>
      Object.fromEntries(
        Object.entries({
          kind,
          covers,
          ref: labelOf(ref),
          rejectRef: labelOf(rejectRef),
        }).filter(([, value]) => value !== undefined),
      ),
    );
    assert.deepEqual(
      actual,
      wanted,
      `${name}: ${JSON.stringify(snapshot.blockers)}`,
    );
    for (const blocker of snapshot.blockers) {
      if (blocker.kind === "captcha") {
        assert.equal(
          blocker.ref,
          undefined,
          `${name}: a person check has no ref`,
        );
        assert.equal(blocker.rejectRef, undefined, name);
      }
      assert.ok(
        blocker.text === undefined || blocker.text.length <= 200,
        `${name}: blocker text is a short excerpt`,
      );
    }
    // The transport names blocker controls by the elements' own selectors.
    const mapped = blockerSelectors(snapshot.blockers, "snap:0");
    for (const [index, blocker] of mapped.entries())
      for (const field of ["ref", "rejectRef"])
        if (snapshot.blockers[index][field] !== undefined)
          assert.equal(
            blocker[field],
            `snap:0:${snapshot.blockers[index][field]}`,
          );
    cases.push(
      `${name}: ${actual.map((item) => `${item.kind}/${item.covers}`).join(", ") || "none"}`,
    );
  }
  // Reporting never answers: the page is unchanged after a snapshot.
  await page.goto(
    `http://127.0.0.1:${server.address().port}/cookie-banner.html`,
  );
  const before = await page.content();
  const cdp = await page.createCDPSession();
  const { frameTree } = await cdp.send("Page.getFrameTree");
  const { executionContextId } = await cdp.send("Page.createIsolatedWorld", {
    frameId: frameTree.frame.id,
    worldName: "eliza-page-blockers-test",
  });
  await cdp.send("Runtime.evaluate", {
    contextId: executionContextId,
    expression: `(${pageCommand.toString()})({subaction:"snapshot"},"blockers-unchanged")`,
    returnByValue: true,
  });
  assert.equal(await page.content(), before);
  cases.push("a snapshot reports a banner without pressing anything");
  const out = testOutputPath("browser-page-blockers");
  await mkdir(out, { recursive: true });
  await writeFile(
    `${out}/verification.json`,
    `${JSON.stringify({ browser: await browser.version(), cases, scope: "Chromium isolated-world blocker reports on local fixture pages only; no arbitrary-site, native-host or Android qualification" }, null, 2)}\n`,
  );
  process.stdout.write(
    `Passed ${cases.length} real Chromium page-blocker cases.\n${cases.join("\n")}\n`,
  );
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
