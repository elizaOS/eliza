import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  buildBrowserProtection,
  composeProtectionAssets,
  renderWarningPage,
  warningCopy,
} from "./build.mjs";
import { REPUTATION_FEEDS } from "./policy.mjs";

test("independent consumers supply warning skins without replacing enforcement or widening capabilities", async () => {
  const directory = await mkdtemp(join(tmpdir(), "protection-consumer-"));
  try {
    await writeFile(
      join(directory, "warning.html"),
      "<h1>Consumer warning</h1>",
    );
    await writeFile(join(directory, "warning.css"), "h1 { font-size: 2rem; }");
    // An override directory cannot replace worker or messaging code.
    await writeFile(
      join(directory, "background.mjs"),
      'throw new Error("wrong worker")',
    );
    const original = {
      "manifest.json": Buffer.from(
        JSON.stringify({ permissions: ["storage", "tabs"] }),
      ),
      "background.mjs": Buffer.from("// host worker"),
    };
    const custom = await composeProtectionAssets(original, {
      warningDirectory: directory,
    });
    const standard = await composeProtectionAssets(original);
    assert.equal(
      custom["warning.html"].toString(),
      "<h1>Consumer warning</h1>",
    );
    assert.notDeepEqual(custom["warning.html"], standard["warning.html"]);
    assert.deepEqual(custom["protection.mjs"], standard["protection.mjs"]);
    assert.deepEqual(custom["policy.mjs"], standard["policy.mjs"]);
    const manifest = JSON.parse(custom["manifest.json"]);
    assert.deepEqual(manifest.permissions, [
      "storage",
      "tabs",
      "declarativeNetRequest",
    ]);
    assert.deepEqual(manifest.web_accessible_resources, [
      { resources: ["warning.html"], matches: ["<all_urls>"] },
    ]);
    assert.deepEqual(JSON.parse(original["manifest.json"]).permissions, [
      "storage",
      "tabs",
    ]);
    await assert.rejects(composeProtectionAssets(custom), /pre-existing/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the default warning names the assistant and lists the configured feeds", async () => {
  const output = await mkdtemp(join(tmpdir(), "protection-warning-"));
  try {
    await buildBrowserProtection(output);
    const html = await readFile(join(output, "warning.html"), "utf8");
    assert.match(html, /<title>Website warning — Eliza<\/title>/);
    assert.ok(html.includes("<p>Eliza stopped it before it opened.</p>"));
    assert.ok(
      html.includes(
        "Community lists: Phishing.Database (MIT) and HaGeZi TIF Mini (GPL-3.0).",
      ),
    );
    assert.doesNotMatch(html, /\{\{/);
    for (const id of ["host", "status", "back", "ask", "confirm", "cancel"])
      assert.match(html, new RegExp(`id="${id}"`));
    const licenses = await readFile(join(output, "licenses.html"), "utf8");
    for (const feed of REPUTATION_FEEDS) {
      assert.ok(licenses.includes(`href="${feed.homepage}"`), feed.id);
      assert.ok(licenses.includes(`${feed.source} (${feed.license})`), feed.id);
    }
    assert.match(licenses, /MIT License/);
    assert.match(licenses, /GNU GENERAL PUBLIC LICENSE/);
    const worker = await readFile(join(output, "background.mjs"), "utf8");
    assert.doesNotMatch(worker, /"notice"|"homepage"/);
    assert.ok(worker.includes(`"url":"${REPUTATION_FEEDS[0].url}"`));
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});

test("warning copy and licenses follow the consumer's assistant name and feed selection", async () => {
  const output = await mkdtemp(join(tmpdir(), "protection-warning-"));
  const [phishing] = REPUTATION_FEEDS;
  try {
    await buildBrowserProtection(output, {
      feeds: [phishing],
      warning: {
        assistantName: "Ada & Co",
        copy: { limits: "Lists cannot catch every <harmful> website." },
      },
    });
    const html = await readFile(join(output, "warning.html"), "utf8");
    assert.match(html, /<title>Website warning — Ada &amp; Co<\/title>/);
    assert.ok(html.includes("Ada &amp; Co stopped it before it opened."));
    assert.ok(html.includes("Community lists: Phishing.Database (MIT)."));
    assert.ok(
      html.includes("Lists cannot catch every &lt;harmful&gt; website."),
    );
    const licenses = await readFile(join(output, "licenses.html"), "utf8");
    assert.match(licenses, /MIT License/);
    assert.doesNotMatch(licenses, /HaGeZi|GNU GENERAL PUBLIC LICENSE/);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
  for (const key of ["footer", "constructor", "toString"])
    assert.throws(() => warningCopy({ copy: { [key]: "x" } }), new RegExp(key));
  assert.throws(() => warningCopy({ copy: { heading: 1 } }), /heading/);
  await assert.rejects(
    buildBrowserProtection(output, {
      feeds: [{ ...phishing, notice: undefined }],
    }),
    /license notice/,
  );
});

test("consumer warning pages may use the copy slots; unknown slots reject", () => {
  const copy = warningCopy({ assistantName: "Ada" });
  assert.equal(
    renderWarningPage("<title>{{title}}</title><p>{{feeds}}</p>", copy),
    "<title>Website warning — Ada</title><p>Community lists: Phishing.Database (MIT) and HaGeZi TIF Mini (GPL-3.0).</p>",
  );
  assert.equal(renderWarningPage("<h1>Static</h1>", copy), "<h1>Static</h1>");
  assert.equal(
    renderWarningPage(
      "<meta content='{{stopped}}'>",
      warningCopy({ assistantName: "O'Neil" }),
    ),
    "<meta content='O&#39;Neil stopped it before it opened.'>",
  );
  assert.throws(() => renderWarningPage("{{footer}}", copy), /footer/);
});

test("the default warning style adapts to dark, high-contrast and forced-colors modes", async () => {
  const css = await readFile(new URL("./warning.css", import.meta.url), "utf8");
  assert.match(css, /@media \(prefers-color-scheme: dark\)/);
  assert.match(css, /@media \(prefers-contrast: more\)/);
  const forced = css.split("@media (forced-colors: active)")[1] ?? "";
  for (const color of ["ButtonText", "ButtonFace", "Highlight"])
    assert.ok(forced.includes(color), color);
  assert.doesNotMatch(forced, /#[0-9a-f]{3,6}\b/i);
  assert.doesNotMatch(css, /forced-color-adjust:\s*none/);
});
