import { chromium } from 'playwright';

const BASE = 'http://localhost:6006';

const res = await fetch(`${BASE}/index.json`);
const index = await res.json();
const ids = Object.entries(index.entries)
  .filter(([k, v]) => k.toLowerCase().includes('chat') && v.type === 'story')
  .map(([k]) => k);

console.log(`Found ${ids.length} chat stories\n`);

const browser = await chromium.launch();
const results = [];

for (const id of ids) {
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 800 } });
  const page = await ctx.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });

  let status = 'unknown';
  let detail = '';
  try {
    await page.goto(`${BASE}/iframe.html?id=${id}&viewMode=story`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    // wait until storybook settles: body shows main OR error OR nopreview
    await page
      .waitForFunction(
        () => {
          const c = document.body.className;
          return (
            c.includes('sb-show-errordisplay') ||
            c.includes('sb-show-nopreview') ||
            (c.includes('sb-show-main') &&
              (document.getElementById('storybook-root')?.childElementCount ?? 0) > 0)
          );
        },
        { timeout: 20000 },
      )
      .catch(() => {});
    // settle dwell for late throws / effects
    await page.waitForTimeout(600);

    const info = await page.evaluate(() => {
      const root = document.getElementById('storybook-root');
      const cls = document.body.className;
      const errEl = document.querySelector('.sb-errordisplay');
      return {
        cls,
        rootChildren: root ? root.childElementCount : -1,
        rootTextLen: root ? root.innerText.trim().length : -1,
        errText: cls.includes('sb-show-errordisplay') && errEl ? errEl.innerText.slice(0, 300) : '',
      };
    });

    if (info.cls.includes('sb-show-errordisplay')) {
      status = 'ERROR_DISPLAY';
      detail = info.errText.replace(/\s+/g, ' ').trim();
    } else if (info.cls.includes('sb-show-nopreview')) {
      status = 'NO_PREVIEW';
    } else if (info.rootChildren > 0) {
      status = 'RENDERED';
      detail = `children=${info.rootChildren} textLen=${info.rootTextLen}`;
    } else {
      status = 'EMPTY';
    }
  } catch (e) {
    status = 'NAV_FAIL';
    detail = String(e.message).slice(0, 200);
  }

  const ok = status === 'RENDERED' && pageErrors.length === 0;
  results.push({ id, status, ok, pageErrors, consoleErrors, detail });
  const tag = ok ? 'OK  ' : 'FAIL';
  console.log(
    `${tag} ${status.padEnd(14)} ${id}` +
      (pageErrors.length ? `\n      pageerror: ${pageErrors.join(' | ').slice(0, 300)}` : '') +
      (detail && !ok ? `\n      detail: ${detail}` : ''),
  );

  await ctx.close();
}

await browser.close();

const fails = results.filter((r) => !r.ok);
console.log(`\n===== SUMMARY =====`);
console.log(`Total: ${results.length}  OK: ${results.length - fails.length}  FAIL: ${fails.length}`);
if (fails.length) {
  console.log(`\nFailures:`);
  for (const f of fails) {
    console.log(`  - ${f.id} [${f.status}]`);
    if (f.pageErrors.length) console.log(`      pageerror: ${f.pageErrors.join(' | ')}`);
    if (f.detail) console.log(`      ${f.detail}`);
  }
}
// also surface console errors even when render OK
const withConsole = results.filter((r) => r.consoleErrors.length);
if (withConsole.length) {
  console.log(`\nStories with console.error output:`);
  for (const r of withConsole) {
    console.log(`  - ${r.id}: ${r.consoleErrors.slice(0, 3).join(' | ').slice(0, 400)}`);
  }
}
process.exit(fails.length ? 1 : 0);
