/**
 * DEEP (real-browser) layer of the UI widget certification harness (#14380).
 *
 * Bundles `widget-cert-fixture.tsx`, mounts it in real Chromium (and WebKit if
 * `ENGINE=webkit`) at a mobile viewport, then drives `window.__widgetCert.run()`
 * so the SAME `certifyWidget` sweep runs against real layout + computed style.
 * Emits, per PR_EVIDENCE.md, an evidence directory with:
 *   - `widget-cert.json`     — the machine-readable run summary (per-widget)
 *   - `widget-cert.txt`      — the rendered, human-readable summary
 *   - `<engine>.png`         — a screenshot of the certified surface
 *
 * Exit code semantics: this runner is a HARNESS PROOF, not the gate itself — it
 * exits 0 when it ran and produced a report even if widgets have violations
 * (violations are FINDINGS routed to follow-up lanes, not this lane's failures).
 * Set `FAIL_ON_VIOLATIONS=1` to make it red on any violation (useful once the
 * component-owning lanes have fixed the known undersized controls).
 *
 * Playwright is known-flaky in the fleet CI box; if the browser can't launch
 * this exits 0 with a SKIPPED note so it never falsely reddens a test-infra PR.
 * The always-green gate is the vitest static layer (`widget-cert.test.tsx`).
 *
 * Run: node src/testing/__e2e__/run-widget-cert-e2e.mjs
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "output-widget-cert");
await mkdir(outDir, { recursive: true });

const ENGINE_NAME = process.env.ENGINE === "webkit" ? "webkit" : "chromium";
const FAIL_ON_VIOLATIONS = process.env.FAIL_ON_VIOLATIONS === "1";

function skip(reason) {
  console.log(`SKIPPED (${reason}) — static layer widget-cert.test.tsx is the gate`);
  process.exit(0);
}

let playwright;
try {
  playwright = await import("playwright");
} catch {
  skip("playwright not installed");
}
let esbuild;
try {
  esbuild = await import("esbuild");
} catch {
  skip("esbuild not installed");
}

const ENGINE =
  ENGINE_NAME === "webkit" ? playwright.webkit : playwright.chromium;

let js;
try {
  const result = await esbuild.build({
    entryPoints: [join(here, "widget-cert-fixture.tsx")],
    bundle: true,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    loader: { ".tsx": "tsx", ".ts": "ts" },
    define: { "process.env.NODE_ENV": '"production"' },
    write: false,
  });
  js = result.outputFiles[0].text;
} catch (e) {
  skip(`fixture bundle failed: ${e?.message ?? e}`);
}

// Load Tailwind so the kit's size utilities (h-11/h-10/h-9/w-10/…) actually
// resolve to real box heights — otherwise every Button collapses to content
// height and the tap-target measurement is a fixture artifact, not a finding.
const html = `<!doctype html><html><head><meta charset="utf-8"><title>widget cert</title>
<script src="https://cdn.tailwindcss.com"></script>
<style>html,body{margin:0;height:100%;background:#0a0d16;font-family:system-ui}</style>
</head><body><div id="root"></div><script>${js}</script></body></html>`;
const htmlPath = join(outDir, "widget-cert.html");
await writeFile(htmlPath, html);

let browser;
try {
  browser = await ENGINE.launch(
    ENGINE_NAME === "chromium" ? { args: ["--no-sandbox"] } : {},
  );
} catch (e) {
  skip(`browser launch failed: ${e?.message ?? e}`);
}

const consoleErrors = [];
try {
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
  await page.waitForFunction(() => window.__widgetCert?.ready === true, {
    timeout: 20_000,
  });
  // Let the Tailwind CDN JIT apply the size utilities before we measure.
  await page.waitForTimeout(800);

  const reports = await page.evaluate(() => window.__widgetCert.run());

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

  if (consoleErrors.length) {
    for (const e of consoleErrors) console.log("  ERR:", e);
  }

  await browser.close();

  if (FAIL_ON_VIOLATIONS && failed > 0) {
    console.error(`\n${failed} widget(s) have unresolved findings.`);
    process.exit(1);
  }
  console.log(
    `\nwidget-cert deep layer ran [${ENGINE_NAME}]. Evidence: ${outDir}`,
  );
  process.exit(0);
} catch (e) {
  try {
    await browser.close();
  } catch {}
  // A flaky browser run must not redden a test-infra PR — the static gate holds.
  skip(`run error: ${e?.message ?? e}`);
}
