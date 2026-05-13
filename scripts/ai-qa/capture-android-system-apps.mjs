#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import sharp from "sharp";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../..");
const PORTS_FILE = join(HERE, ".static-stack.json");
const RUN_ID =
  process.env.AI_QA_RUN_ID ?? new Date().toISOString().replace(/[:.]/g, "-");
const REPORT_DIR = resolve(
  REPO_ROOT,
  "reports",
  "apps-manual-qa",
  `android-system-${RUN_ID}`,
);

const ANDROID_ELIZA_UA =
  "Mozilla/5.0 (Linux; Android 15; ElizaOS QA) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36 ElizaOS/qa";

const VIEWPORTS = {
  desktop: { width: 1280, height: 720 },
  mobile: { width: 390, height: 844 },
};

const APPS = [
  {
    id: "phone",
    label: "Phone",
    path: "/apps/phone",
    ready: '[data-testid="phone-shell"]',
  },
  {
    id: "contacts",
    label: "Contacts",
    path: "/apps/contacts",
    ready: '[data-testid="contacts-shell"]',
  },
  {
    id: "wifi",
    label: "WiFi",
    path: "/apps/wifi",
    ready: '[data-testid="wifi-shell"]',
  },
  {
    id: "messages",
    label: "Messages",
    path: "/apps/messages",
    ready: '[data-testid="messages-shell"]',
  },
  {
    id: "device-settings",
    label: "Device Settings",
    path: "/apps/device-settings",
    ready: '[data-testid="device-settings-shell"]',
  },
];

const BENIGN_ISSUES = [
  /"Keyboard" plugin is not implemented on web/i,
  /\[Eliza\] Network plugin not available: Cannot read properties of undefined \(reading 'addListener'\)/i,
];

async function ensureDir(path) {
  await mkdir(path, { recursive: true });
}

function isBenignIssue(text) {
  return BENIGN_ISSUES.some((pattern) => pattern.test(text));
}

async function readUiBase() {
  const raw = await readFile(PORTS_FILE, "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed.uiBase) throw new Error("Missing uiBase in .static-stack.json");
  return parsed.uiBase;
}

async function verifyStaticStack(uiBase) {
  const statusUrl = `${uiBase}/api/status`;
  let response;
  try {
    response = await fetch(statusUrl);
  } catch (error) {
    throw new Error(
      `Static QA stack is not reachable at ${statusUrl}. Restart it with scripts/ai-qa/static-stack.mjs. Cause: ${String(error)}`,
    );
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Static QA stack status failed at ${statusUrl}: ${response.status} ${body}`,
    );
  }
  const payload = await response.json().catch(() => null);
  if (!payload || payload.state !== "running") {
    throw new Error(
      `Static QA stack is not running at ${statusUrl}: ${JSON.stringify(payload)}`,
    );
  }
}

async function seedPage(page) {
  await page.addInitScript(() => {
    let capacitorValue = Reflect.get(window, "Capacitor");
    const patchCapacitor = (value) => {
      if (value && typeof value === "object") {
        Reflect.set(value, "getPlatform", () => "android");
        Reflect.set(value, "isNativePlatform", () => false);
      }
      return value;
    };

    Object.defineProperty(window, "Capacitor", {
      configurable: true,
      get() {
        return capacitorValue;
      },
      set(value) {
        capacitorValue = patchCapacitor(value);
      },
    });
    capacitorValue = patchCapacitor(capacitorValue);

    const storage = {
      "eliza:onboarding-complete": "1",
      "eliza:onboarding:step": "activate",
      "eliza:ui-shell-mode": "native",
      "eliza:ui-theme": "dark",
      "elizaos:ui-theme": "dark",
      "elizaos:active-server": JSON.stringify({
        id: "local:embedded",
        kind: "local",
        label: "This device",
      }),
    };
    for (const [key, value] of Object.entries(storage)) {
      localStorage.setItem(key, value);
    }
  });
}

function installIssueCapture(page) {
  const logs = [];
  const issues = [];
  page.on("console", (message) => {
    const entry = {
      type: message.type(),
      text: message.text(),
      location: message.location(),
    };
    logs.push(entry);
    if (message.type() === "error" && !isBenignIssue(message.text())) {
      issues.push({ kind: "console.error", detail: message.text() });
    }
  });
  page.on("pageerror", (error) => {
    if (isBenignIssue(error.message)) return;
    issues.push({ kind: "pageerror", detail: error.message });
  });
  page.on("requestfailed", (request) => {
    const url = request.url();
    if (url.startsWith("data:") || url.startsWith("blob:")) return;
    const failure = request.failure()?.errorText ?? "unknown";
    if (failure === "net::ERR_ABORTED") return;
    issues.push({
      kind: "requestfailed",
      detail: `${request.method()} ${url} ${failure}`,
    });
  });
  return { logs, issues };
}

async function interact(page, appId) {
  if (appId === "phone") {
    await page.getByTestId("phone-dial-key-1").click();
    await page.getByTestId("phone-dial-key-2").click();
    await page.getByTestId("phone-dial-key-3").click();
    await page.getByTestId("phone-dial-backspace").click();
    await page.getByRole("tab", { name: "Recent" }).click();
    return "Dialed 123, deleted one digit, opened Recent.";
  }
  if (appId === "contacts") {
    await page.getByTestId("contacts-new").click();
    await page.getByPlaceholder("Full name").fill("Ada Lovelace");
    await page.getByPlaceholder("+1 555 123 4567").fill("+1 555 0100");
    await page.getByRole("button", { name: "Cancel" }).click();
    return "Opened and canceled New contact.";
  }
  if (appId === "wifi") {
    await page.getByTestId("wifi-scan").click();
    return "Triggered scan.";
  }
  if (appId === "messages") {
    await page.getByTestId("messages-new").click();
    await page.getByTestId("messages-compose-address").fill("+1 555 0101");
    await page.getByTestId("messages-compose-body").fill("QA SMS draft");
    return "Opened composer and drafted an SMS without sending.";
  }
  if (appId === "device-settings") {
    await page.getByTestId("device-settings-brightness").fill("67");
    const media = page.getByTestId("device-settings-volume-music");
    if (await media.isVisible().catch(() => false)) {
      await media.fill("8");
    }
    return "Adjusted brightness and media-volume sliders without applying.";
  }
  return "Loaded.";
}

async function captureOne({ browser, uiBase, app, viewportName, viewport }) {
  const context = await browser.newContext({
    viewport,
    colorScheme: "dark",
    userAgent: ANDROID_ELIZA_UA,
  });
  const page = await context.newPage();
  await seedPage(page);
  const { logs, issues } = installIssueCapture(page);
  const startedAt = Date.now();
  const url = `${uiBase}/?appWindow=1&qaApp=${encodeURIComponent(app.id)}#${app.path}`;
  let readyOk = false;
  let interaction = "";
  try {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.locator(app.ready).waitFor({ state: "visible", timeout: 60_000 });
    readyOk = true;
    interaction = await interact(page, app.id);
    await page.waitForTimeout(250);
  } catch (error) {
    issues.push({ kind: "capture-error", detail: error.message });
  }

  const captureDir = join(REPORT_DIR, "captures", app.id);
  await ensureDir(captureDir);
  const screenshotRelPath = join(
    "captures",
    app.id,
    `${app.id}__${viewportName}.png`,
  );
  await page.screenshot({
    path: join(REPORT_DIR, screenshotRelPath),
    fullPage: false,
    type: "png",
  });

  const metrics = await page.evaluate(() => ({
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    scrollWidth: document.documentElement.scrollWidth,
    scrollHeight: document.documentElement.scrollHeight,
    bodyText: document.body.innerText.slice(0, 3000),
  }));

  await context.close();
  return {
    appId: app.id,
    label: app.label,
    path: app.path,
    viewport: viewportName,
    screenshotRelPath,
    readyOk,
    interaction,
    navMs: Date.now() - startedAt,
    metrics,
    issues,
    logs,
  };
}

function issueSummary(records) {
  const all = records.flatMap((record) =>
    record.issues.map((issue) => ({
      appId: record.appId,
      viewport: record.viewport,
      ...issue,
    })),
  );
  return all;
}

async function makeContactSheet(records, viewport) {
  const rows = records.filter((record) => record.viewport === viewport);
  if (rows.length === 0) return;

  const tileWidth = viewport === "desktop" ? 480 : 220;
  const tileHeight = viewport === "desktop" ? 300 : 300;
  const labelHeight = 28;
  const gap = 12;
  const columns = viewport === "desktop" ? 3 : 5;
  const sheetWidth = columns * tileWidth + (columns + 1) * gap;
  const sheetHeight =
    Math.ceil(rows.length / columns) * (tileHeight + labelHeight + gap) + gap;
  const composites = [];

  for (let index = 0; index < rows.length; index += 1) {
    const record = rows[index];
    const left = gap + (index % columns) * (tileWidth + gap);
    const top = gap + Math.floor(index / columns) * (tileHeight + labelHeight + gap);
    const image = await sharp(join(REPORT_DIR, record.screenshotRelPath))
      .resize(tileWidth, tileHeight, { fit: "contain", background: "#09090b" })
      .png()
      .toBuffer();
    const label = await sharp({
      create: {
        width: tileWidth,
        height: labelHeight,
        channels: 4,
        background: "#111116",
      },
    })
      .composite([
        {
          input: Buffer.from(
            `<svg width="${tileWidth}" height="${labelHeight}"><text x="0" y="20" fill="#f4f4f5" font-size="18" font-family="Arial">${record.label}</text></svg>`,
          ),
        },
      ])
      .png()
      .toBuffer();
    composites.push({ input: label, left, top });
    composites.push({ input: image, left, top: top + labelHeight });
  }

  await sharp({
    create: {
      width: sheetWidth,
      height: sheetHeight,
      channels: 4,
      background: "#111116",
    },
  })
    .composite(composites)
    .png()
    .toFile(join(REPORT_DIR, `contact-sheet-${viewport}.png`));
}

async function main() {
  await ensureDir(REPORT_DIR);
  const uiBase = await readUiBase();
  await verifyStaticStack(uiBase);
  const browser = await chromium.launch();
  const records = [];
  try {
    for (const app of APPS) {
      for (const [viewportName, viewport] of Object.entries(VIEWPORTS)) {
        await verifyStaticStack(uiBase);
        records.push(await captureOne({ browser, uiBase, app, viewportName, viewport }));
        await verifyStaticStack(uiBase);
      }
    }
  } finally {
    await browser.close();
  }

  const report = {
    runId: RUN_ID,
    uiBase,
    generatedAt: new Date().toISOString(),
    records,
    issueSummary: issueSummary(records),
  };
  await writeFile(join(REPORT_DIR, "report.json"), JSON.stringify(report, null, 2));
  await makeContactSheet(records, "desktop");
  await makeContactSheet(records, "mobile");
  console.log(REPORT_DIR);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
