import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright/test";

const root = path.resolve(import.meta.dirname, "..");
const outDir = path.join(root, "artifacts", "screenshots");
const baseUrl = process.env.OS_HOMEPAGE_URL ?? "http://127.0.0.1:4455";

const shots = [
  { name: "desktop-home", width: 1440, height: 1000, fullPage: true },
  { name: "desktop-hero", width: 1280, height: 720, fullPage: false },
  { name: "tablet-home", width: 820, height: 1180, fullPage: true },
  { name: "mobile-home", width: 390, height: 1100, fullPage: true },
];

await mkdir(outDir, { recursive: true });

const browser = await chromium.launch();
const captured = [];

try {
  for (const shot of shots) {
    const page = await browser.newPage({
      viewport: { width: shot.width, height: shot.height },
    });
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    const file = path.join(outDir, `${shot.name}.png`);
    await page.screenshot({ path: file, fullPage: shot.fullPage });
    await page.close();
    captured.push({ ...shot, file: path.basename(file) });
  }

  const contactHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>ElizaOS homepage contact sheet</title>
  <style>
    body { margin: 0; padding: 24px; background: #171717; color: #fbfaf7; font-family: ui-sans-serif, system-ui; }
    h1 { margin: 0 0 18px; font-size: 28px; }
    .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; }
    figure { margin: 0; border: 1px solid #4a4038; background: #24211f; }
    img { width: 100%; display: block; }
    figcaption { padding: 10px 12px; color: #f3c7a8; font-size: 14px; }
  </style>
</head>
<body>
  <h1>ElizaOS homepage contact sheet</h1>
  <div class="grid">
    ${captured
      .map(
        (shot) => `<figure>
      <img src="./${shot.file}" alt="${shot.name}" />
      <figcaption>${shot.name} - ${shot.width}x${shot.height}</figcaption>
    </figure>`,
      )
      .join("\n")}
  </div>
</body>
</html>`;
  const contactHtmlPath = path.join(outDir, "contact-sheet.html");
  await writeFile(contactHtmlPath, contactHtml);

  const page = await browser.newPage({
    viewport: { width: 1400, height: 1200 },
  });
  await page.goto(`file://${contactHtmlPath}`, { waitUntil: "load" });
  await page.screenshot({
    path: path.join(outDir, "contact-sheet.png"),
    fullPage: true,
  });
  await page.close();
} finally {
  await browser.close();
}

console.log(`Wrote screenshots and contact sheet to ${outDir}`);
