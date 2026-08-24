/** Runs deterministic two-surface pairing lifecycle proof in Chromium. */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const html = await readFile(join(here, "devices-runtimes-pairing-demo.html"));
const server = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(html);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("Demo server unavailable");

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const url = `http://127.0.0.1:${address.port}`;
await page.goto(url);
await page.evaluate(() => localStorage.clear());
await page.reload();
await page.getByRole("button", { name: "Create one-use code" }).click();
await page.getByRole("button", { name: "Try wrong code" }).click();
if (!(await page.getByText("Wrong code rejected.").isVisible())) throw new Error("Wrong code did not fail closed");
await page.getByRole("button", { name: "Scan displayed QR" }).click();
await page.getByRole("button", { name: "Simulate identity mismatch" }).click();
if (!(await page.getByText(/Identity mismatch/).isVisible())) throw new Error("Identity mismatch did not fail closed");
await page.getByRole("button", { name: "Confirm and activate once" }).click();
await page.reload();
if (!(await page.getByText("Active controller").isVisible())) throw new Error("Relaunch did not persist activation");
await page.screenshot({ path: join(here, "devices-runtimes-pairing-demo.png"), fullPage: true });
await page.getByRole("button", { name: "Revoke controller" }).click();
if (!(await page.getByText(/session terminated/).isVisible())) throw new Error("Revocation did not terminate access");
await browser.close();
await new Promise((resolve) => server.close(resolve));
console.log(`Devices & Runtimes pairing demo passed: ${url}`);
