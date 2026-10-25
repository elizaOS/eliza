/**
 * Certifies rendered UI widgets in Chromium or WebKit and writes the current
 * run's measurements, summary, and screenshot. Dependency, bundle, browser,
 * and execution failures fail the command and never preserve old evidence.
 * Completed layout findings are diagnostic unless FAIL_ON_VIOLATIONS=1.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "output-widget-cert");
const ENGINE_NAME = process.env.ENGINE === "webkit" ? "webkit" : "chromium";
const FAIL_ON_VIOLATIONS = process.env.FAIL_ON_VIOLATIONS === "1";
let browser;

try {
  // Clear the owned output before loading dependencies: a startup failure must
  // not leave a prior run's passing report for CI to upload.
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const playwright = await import("playwright");
  const { bundleFixture, buildFixtureHtml, compileTailwindTheme } = await import(
    "../e2e-runner/fixture-bundle.ts"
  );
  const js = await bundleFixture({
    entry: join(here, "widget-cert-fixture.tsx"),
  });
  const uiRoot = resolve(here, "../../..");
  const css = await compileTailwindTheme({
    uiRoot,
    sources: [here, join(uiRoot, "src/components/ui")],
  });
  const html = buildFixtureHtml({
    js,
    title: "widget cert",
    tailwind: { css },
    background: "#0a0d16",
  });
  const htmlPath = join(outDir, "widget-cert.html");
  await writeFile(htmlPath, html);

  const engine =
    ENGINE_NAME === "webkit" ? playwright.webkit : playwright.chromium;
  browser = await engine.launch(
    ENGINE_NAME === "chromium" ? { args: ["--no-sandbox"] } : {},
  );

  const consoleErrors = [];
  const page = await browser.newPage({
    viewport: { width: 402, height: 874 },
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 2,
  });
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  page.on("pageerror", (e) => consoleErrors.push(String(e)));

  await page.goto(`file://${htmlPath}`);
  await page.waitForFunction(
    () => window.__widgetCert?.ready === true,
    undefined,
    { timeout: 20_000 },
  );
  await page.locator('[data-testid="demo-buttons"]').waitFor();
  await page.locator("#continuous-thread").waitFor();

  const reports = await page.evaluate(() => window.__widgetCert.run());

  if (reports.length === 0) {
    throw new Error("Widget certification produced no reports.");
  }
  if (consoleErrors.length > 0) {
    throw new Error(
      `Widget certification browser errors:\n${consoleErrors.join("\n")}`,
    );
  }
  const failed = reports.filter((r) => !r.passed).length;
  const run = {
    runAt: new Date().toISOString(),
    engine: ENGINE_NAME,
    passed: failed === 0,
    total: reports.length,
    failed,
    reports,
    consoleErrors,
  };

  await writeFile(
    join(outDir, "widget-cert.json"),
    `${JSON.stringify(run, null, 2)}\n`,
  );

  const lines = [];
  lines.push(
    `UI widget certification (deep/${ENGINE_NAME}) — ${run.passed ? "PASS" : "FINDINGS"}`,
  );
  lines.push(
    `${run.total - run.failed}/${run.total} widgets certified (${run.failed} with findings) @ ${run.runAt}`,
  );
  lines.push("");
  for (const r of reports) {
    lines.push(
      `${r.passed ? "\u2713" : "\u2717"} ${r.widget}  [${r.dimensions.join(", ")}]`,
    );
    for (const v of r.violations) {
      lines.push(
        `    \u2717 (${v.dimension}) ${v.code}${v.target ? ` @ ${v.target}` : ""}: ${v.message}`,
      );
    }
  }
  const summary = lines.join("\n");
  await writeFile(join(outDir, "widget-cert.txt"), `${summary}\n`);
  console.log(summary);

  await page.screenshot({ path: join(outDir, `${ENGINE_NAME}.png`) });

  if (FAIL_ON_VIOLATIONS && failed > 0) {
    throw new Error(`${failed} widget(s) have unresolved findings.`);
  }
  console.log(
    `\nwidget-cert deep layer ran [${ENGINE_NAME}]. Evidence: ${outDir}`,
  );
} catch (error) {
  // error-policy:J1 the executable boundary reports a failed certification
  // command; completed diagnostic findings keep their explicit opt-in policy.
  console.error("Widget certification failed:", error);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
}
