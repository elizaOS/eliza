#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

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

async function ensureDir(path) {
  await mkdir(path, { recursive: true });
}

async function readUiBase() {
  const raw = await readFile(PORTS_FILE, "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed.uiBase) throw new Error("Missing uiBase in .static-stack.json");
  return parsed.uiBase;
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
    if (message.type() === "error") {
      issues.push({ kind: "console.error", detail: message.text() });
    }
  });
  page.on("pageerror", (error) => {
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

async function main() {
  await ensureDir(REPORT_DIR);
  const uiBase = await readUiBase();
  const browser = await chromium.launch();
  const records = [];
  try {
    for (const app of APPS) {
      for (const [viewportName, viewport] of Object.entries(VIEWPORTS)) {
        records.push(await captureOne({ browser, uiBase, app, viewportName, viewport }));
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
  console.log(REPORT_DIR);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
