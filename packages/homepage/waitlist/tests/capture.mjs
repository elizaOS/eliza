import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
const browser = await chromium.launch({ headless: true, executablePath: "/home/shad0w/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome" });
await mkdir("local-capture", { recursive: true });
for (const [name, viewport] of [["desktop", { width: 1440, height: 1000 }], ["mobile", { width: 390, height: 844 }]]) {
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  await page.goto("http://127.0.0.1:8877", { waitUntil: "networkidle" });
  await page.screenshot({ path: `local-capture/${name}.png`, fullPage: true });
  console.log(name, await page.title(), errors);
  await page.close();
}
await browser.close();
