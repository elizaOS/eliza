import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { compileTailwindTheme, writeFixturePage } from "../../testing/e2e-runner/fixture-bundle.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../../../..");
const out = resolve(root, process.env.SIGN_IN_EVIDENCE_DIR || "test-results/shared-session-conductor/review-r2-browser");
await mkdir(out, { recursive:true });
const css = await compileTailwindTheme({uiRoot:resolve(here,"../../.."),sources:[resolve(here,"..")]});
const sourcePath = "packages/ui/src/android-cloud/NativeCloudSignInView.tsx";
const stylePath = "packages/ui/src/styles/native-cloud-sign-in.css";
const baseline = "d25a1bda751ba248d59970ee25090ab25eb03f07";
const urls = {};
for (const version of ["before","after"]) {
  const before = version === "before";
  const nativeCss = before ? execFileSync("git",["show",`${baseline}:${stylePath}`],{cwd:root,encoding:"utf8"}) : await readFile(resolve(root,stylePath),"utf8");
  const plugins = before ? [{name:"review-baseline",setup(build){build.onLoad({filter:/\/NativeCloudSignInView\.tsx$/}, () => ({contents:execFileSync("git",["show",`${baseline}:${sourcePath}`],{cwd:root,encoding:"utf8"}),loader:"tsx"}));}}] : [];
  urls[version] = await writeFixturePage({entry:join(here,"native-cloud-sign-in-fixture.tsx"),outDir:out,htmlName:`${version}.html`,title:`${version}: controlled native sign-in`,plugins,processShim:true,tailwind:{css},headHtml:`<meta name="viewport" content="width=device-width, initial-scale=1"><style>:root{--bg:#fafafa;--text:#18181b;--surface:#f0f0f2;--border:#909096;--accent:#2459c4}body{margin:0}${nativeCss}</style>`});
}
const browser = await chromium.launch({headless:true});
const context = await browser.newContext({viewport:{width:1280,height:900},recordVideo:{dir:join(out,"video"),size:{width:1280,height:900}}});
const page = await context.newPage();
const errors = [];
page.on("pageerror", error => errors.push(error.message));
const checks = [];
async function checkpoint(name) { await page.screenshot({path:join(out,`${name}.png`)}); await page.waitForTimeout(600); }
function check(ok, message) { checks.push({ok,message}); console.log(`${ok?"PASS":"FAIL"} ${message}`); if(!ok)throw new Error(message); }
try {
  await page.goto(urls.before);
  await page.getByRole("heading",{name:"Sign in to Eliza Cloud",exact:true}).waitFor();
  const before = await page.locator("[data-native-cloud-sign-in]").evaluate(node => getComputedStyle(node).backgroundColor);
  check(before === "rgba(0, 0, 0, 0)", "d25 before overlay exposes its underlying shell");
  await page.screenshot({path:join(out,"before-desktop.png")});
  await page.waitForTimeout(1000);
  await page.goto(urls.after);
  await page.getByRole("heading",{name:"Sign in to Eliza Cloud",exact:true}).waitFor();
  const after = await page.locator("[data-native-sign-in-overlay]").evaluate(node => getComputedStyle(node).backgroundColor);
  check(after === "rgb(250, 250, 250)", "after full-screen overlay is opaque across the viewport");
  await checkpoint("after-desktop");
  await page.getByRole("button",{name:"Continue with Google",exact:true}).click();
  await page.getByText("Choose your Google account in the Android sign-in sheet. Eliza will finish signing you in.").waitFor();
  await checkpoint("after-google-pending");
  await page.getByTestId("native-cloud-sign-in-cancel").click();
  await page.getByLabel("Email",{exact:true}).fill("owner@example.invalid");
  await page.getByRole("button",{name:"Email me a code",exact:true}).click();
  const code = page.getByTestId("native-cloud-sign-in-code");
  await code.fill("000000");
  await page.getByRole("button",{name:"Verify",exact:true}).click();
  await page.getByTestId("native-cloud-sign-in-error").waitFor();
  await checkpoint("after-invalid-code");
  await code.fill("123456");
  await page.getByRole("button",{name:"Verify",exact:true}).click();
  await page.getByText("Enter the 6-digit code from your authenticator app to finish signing in.").waitFor();
  await checkpoint("after-mfa");
  await code.fill("222333");
  await page.getByRole("button",{name:"Verify",exact:true}).click();
  await page.getByRole("button",{name:"Retry connection",exact:true}).waitFor();
  await checkpoint("after-activation-retry");
  await page.getByRole("button",{name:"Retry connection",exact:true}).click();
  await page.getByText("Signed in.",{exact:true}).waitFor();
  check((await page.evaluate(() => window.signInFixtureStats)).activated === 2,"translated retry completes account readback without another native sign-in");
  await checkpoint("after-retry-complete");
  for(const [name,width,height,scale] of [["phone",390,844,1],["phone-300",390,844,3],["landscape-300",844,390,3]]) {
    await page.setViewportSize({width,height});
    await page.goto(urls.after);
    await page.getByRole("button",{name:"Continue with Google",exact:true}).waitFor();
    await page.evaluate(scale => document.documentElement.style.fontSize=`${16*scale}px`,scale);
    check(await page.evaluate(() => document.documentElement.scrollWidth<=innerWidth),`${name}: no horizontal clipping`);
    await page.screenshot({path:join(out,`after-${name}-initial.png`)});
    await page.getByLabel("Email",{exact:true}).focus();
    await page.keyboard.type("owner@example.invalid");
    await page.keyboard.press("Tab");
    const focus = await page.evaluate(() => {const r=document.activeElement.getBoundingClientRect();return {text:document.activeElement.textContent,visible:r.top>=0&&r.bottom<=innerHeight};});
    await page.screenshot({path:join(out,`after-${name}-focused.png`)});
    console.log(name, focus);
    check(focus.text === "Email me a code" && focus.visible,`${name}: keyboard reaches readable email action`);
  }
  await page.goto(`${urls.after}?embedded`);
  await page.getByRole("button",{name:"Continue with Google",exact:true}).waitFor();
  check(await page.locator("[data-native-sign-in-overlay]").count()===0,"embedded surface does not create a viewport overlay");
  await page.screenshot({path:join(out,"after-embedded.png")});
  check(errors.length===0,"no browser page errors");
} finally {
  await writeFile(join(out,"checks.json"),JSON.stringify({baseline,head:execFileSync("git",["rev-parse","HEAD"],{cwd:root,encoding:"utf8"}).trim(),source:"working tree",checks,errors},null,2));
  await context.close(); await browser.close();
}
