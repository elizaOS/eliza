#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${name}`);
  }
  return value;
}

const beforeRepo = path.resolve(argValue("--before", repoRoot));
const afterRepo = path.resolve(argValue("--after", repoRoot));
const outDir = path.resolve(argValue("--out", here));
const nodeModulesSource = path.join(repoRoot, "packages/app/node_modules");
const require = createRequire(import.meta.url);
const lucideReactPath = require.resolve("lucide-react", {
  paths: [path.join(repoRoot, "plugins/plugin-shopify-ui")],
});
const xyflowReactStylePath = require.resolve("@xyflow/react/dist/style.css", {
  paths: [path.join(repoRoot, "packages/ui")],
});

if (!existsSync(nodeModulesSource)) {
  throw new Error(`Expected node_modules at ${nodeModulesSource}`);
}

function jsString(value) {
  return JSON.stringify(value);
}

function gitCommit(repoPath) {
  return execFileSync("git", ["-C", repoPath, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
}

async function ensureNodeModulesLink(targetDir) {
  const linkPath = path.join(targetDir, "node_modules");
  if (existsSync(linkPath)) {
    const current = await readlink(linkPath).catch(() => null);
    if (current === nodeModulesSource) return;
    await rm(linkPath, { recursive: true, force: true });
  }
  await symlink(nodeModulesSource, linkPath, "dir");
}

async function writeHarnessFiles(harnessDir, repoPath) {
  const srcDir = path.join(harnessDir, "src");
  await mkdir(srcDir, { recursive: true });
  await writeFile(
    path.join(harnessDir, "index.html"),
    '<!doctype html><html><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" /><title>9465 visual evidence</title></head><body><div id="root"></div><script type="module" src="/src/app.tsx"></script></body></html>\n',
  );
  await writeFile(
    path.join(harnessDir, "package.json"),
    '{ "type": "module", "private": true }\n',
  );
  await writeFile(
    path.join(srcDir, "ui-stub.tsx"),
    `
import React, { createContext, forwardRef, useContext, useRef } from "react";

type AnyProps = Record<string, unknown> & { children?: React.ReactNode; className?: string };

function stripUiProps(props: AnyProps) {
  const {
    variant: _variant,
    size: _size,
    asChild: _asChild,
    onOpenChange: _onOpenChange,
    ...rest
  } = props;
  return rest;
}

export const Button = forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement> & AnyProps>(
  ({ children, type = "button", ...props }, ref) => (
    <button ref={ref} type={type} {...stripUiProps(props)}>{children}</button>
  ),
);
Button.displayName = "Button";

export const Input = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>((props, ref) => (
  <input ref={ref} {...props} />
));
Input.displayName = "Input";

export function Skeleton({ className = "", ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={className} data-skeleton="true" {...props} />;
}

export function Badge({ children, className = "", ...props }: AnyProps) {
  return <span className={className} {...stripUiProps(props)}>{children}</span>;
}

const TabsContext = createContext<{ value: string; onValueChange: (value: string) => void }>({
  value: "",
  onValueChange: () => {},
});

export function Tabs({ value, onValueChange, children, className = "", ...props }: AnyProps & {
  value: string;
  onValueChange?: (value: string) => void;
}) {
  return (
    <TabsContext.Provider value={{ value, onValueChange: onValueChange ?? (() => {}) }}>
      <div className={className} {...stripUiProps(props)}>{children}</div>
    </TabsContext.Provider>
  );
}

export function TabsList({ children, className = "", ...props }: AnyProps) {
  return <div className={className} role="tablist" {...stripUiProps(props)}>{children}</div>;
}

export const TabsTrigger = forwardRef<HTMLButtonElement, AnyProps & { value: string }>(
  ({ value, children, className = "", ...props }, ref) => {
    const tabs = useContext(TabsContext);
    const active = tabs.value === value;
    return (
      <button
        ref={ref}
        type="button"
        role="tab"
        aria-selected={active}
        data-tab-trigger={value}
        className={className}
        onClick={() => tabs.onValueChange(value)}
        {...stripUiProps(props)}
      >
        {children}
      </button>
    );
  },
);
TabsTrigger.displayName = "TabsTrigger";

export function TabsContent({ value, children, className = "", ...props }: AnyProps & { value: string }) {
  const tabs = useContext(TabsContext);
  if (tabs.value !== value) return null;
  return <div className={className} {...stripUiProps(props)}>{children}</div>;
}

export function Dialog({ open, children }: AnyProps & { open: boolean }) {
  return open ? <div role="dialog">{children}</div> : null;
}

export function DialogContent({ children, className = "", ...props }: AnyProps) {
  return <div className={className} {...stripUiProps(props)}>{children}</div>;
}

export function DialogHeader({ children, className = "", ...props }: AnyProps) {
  return <div className={className} {...stripUiProps(props)}>{children}</div>;
}

export function DialogFooter({ children, className = "", ...props }: AnyProps) {
  return <div className={className} {...stripUiProps(props)}>{children}</div>;
}

export function DialogTitle({ children, className = "", ...props }: AnyProps) {
  return <h2 className={className} {...stripUiProps(props)}>{children}</h2>;
}

export function SegmentedControl({ value, onValueChange, items }: {
  value: string;
  onValueChange: (value: string) => void;
  items: Array<{ value: string; label: React.ReactNode }>;
}) {
  return (
    <div className="inline-flex items-center gap-1">
      {items.map((item) => (
        <button
          key={item.value}
          type="button"
          className={item.value === value ? "font-semibold text-accent" : "text-muted"}
          onClick={() => onValueChange(item.value)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

export function formatShortDate(iso: string) {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(new Date(iso));
}

export function useAgentElement<T extends HTMLElement>() {
  return { ref: useRef<T | null>(null), agentProps: {} };
}

export type OverlayAppContext = {
  exitToApps?: () => void;
  uiTheme?: "light" | "dark" | "system";
  t?: (key: string, opts?: { defaultValue?: string }) => string;
};
`,
  );
  await writeFile(
    path.join(srcDir, "capacitor-system-stub.ts"),
    `
const deviceSettings = {
  brightness: 0.6,
  brightnessMode: "automatic",
  canWriteSettings: true,
  volumes: [
    { stream: "music", current: 9, max: 15 },
    { stream: "ring", current: 5, max: 10 },
    { stream: "alarm", current: 3, max: 10 },
    { stream: "notification", current: 7, max: 10 },
    { stream: "system", current: 2, max: 8 },
    { stream: "voiceCall", current: 4, max: 5 },
  ],
};

const systemStatus = {
  packageName: "ai.eliza",
  roles: [
    { role: "home", androidRole: "android.app.role.HOME", held: true, holders: ["ai.eliza"], available: true },
    { role: "dialer", androidRole: "android.app.role.DIALER", held: false, holders: [], available: false },
    { role: "sms", androidRole: "android.app.role.SMS", held: false, holders: [], available: true },
    { role: "assistant", androidRole: "android.app.role.ASSISTANT", held: false, holders: ["com.other.app"], available: true },
  ],
};

export const System = {
  async getDeviceSettings() {
    return deviceSettings;
  },
  async getStatus() {
    return systemStatus;
  },
  async setScreenBrightness() {
    return deviceSettings;
  },
  async setVolume({ stream, volume }: { stream: string; volume: number }) {
    return { stream, current: volume, max: 15 };
  },
  async requestRole({ role }: { role: string }) {
    return { role, held: true, resultCode: 0 };
  },
  async openSettings() {},
  async openWriteSettings() {},
  async openDisplaySettings() {},
  async openSoundSettings() {},
  async openNetworkSettings() {},
};

export type AndroidRoleName = "home" | "dialer" | "sms" | "assistant";
export type AndroidRoleStatus = typeof systemStatus.roles[number];
export type DeviceSettingsStatus = typeof deviceSettings;
export type SystemStatus = typeof systemStatus;
export type SystemVolumeStatus = typeof deviceSettings.volumes[number];
export type SystemVolumeStream = SystemVolumeStatus["stream"];
`,
  );
  await writeFile(
    path.join(srcDir, "app.tsx"),
    `
import "@elizaos/ui/styles";
import React from "react";
import { createRoot } from "react-dom/client";
import { DeviceSettingsAppView } from "#device-settings";
import { ShopifyAppView } from "#shopify";
import "./evidence.css";

const status = {
  connected: true,
  shop: {
    name: "Eliza Store",
    domain: "eliza.myshopify.com",
    plan: "Shopify Plus",
    email: "ops@example.com",
    currencyCode: "USD",
  },
};

const products = {
  products: [
    {
      id: "product-1",
      title: "Terminal Hoodie",
      status: "ACTIVE",
      productType: "Apparel",
      vendor: "Eliza",
      totalInventory: 9,
      priceRange: { min: "42.00", max: "42.00" },
      imageUrl: null,
      updatedAt: "2026-05-18T12:00:00.000Z",
    },
  ],
  total: 7,
  page: 1,
  pageSize: 20,
};

const orders = {
  orders: [
    { id: "order-1", name: "#1001", email: "a@example.com", totalPrice: "10.00", currencyCode: "USD", fulfillmentStatus: "UNFULFILLED", financialStatus: "PAID", createdAt: "2026-05-18T12:00:00.000Z", lineItemCount: 1 },
    { id: "order-2", name: "#1002", email: "b@example.com", totalPrice: "20.00", currencyCode: "USD", fulfillmentStatus: "FULFILLED", financialStatus: "PAID", createdAt: "2026-05-18T12:00:00.000Z", lineItemCount: 2 },
    { id: "order-3", name: "#1003", email: "c@example.com", totalPrice: "30.00", currencyCode: "USD", fulfillmentStatus: "FULFILLED", financialStatus: "PAID", createdAt: "2026-05-18T12:00:00.000Z", lineItemCount: 1 },
    { id: "order-4", name: "#1004", email: "d@example.com", totalPrice: "40.00", currencyCode: "USD", fulfillmentStatus: "FULFILLED", financialStatus: "PAID", createdAt: "2026-05-18T12:00:00.000Z", lineItemCount: 1 },
  ],
  total: 12,
};

const inventory = {
  items: [
    { id: "inv-0", sku: "OUT-1", productTitle: "Sold Out Tee", variantTitle: "Red", locationId: "loc-1", locationName: "Main", available: 0, incoming: 0 },
    { id: "inv-1", sku: "LOW-1", productTitle: "Low Hoodie", variantTitle: "Black", locationId: "loc-1", locationName: "Main", available: 3, incoming: 0 },
    { id: "inv-2", sku: "OK-1", productTitle: "Stocked Mug", variantTitle: "", locationId: "loc-1", locationName: "Main", available: 40, incoming: 0 },
  ],
  locations: ["Main"],
};

const customers = {
  customers: [
    { id: "customer-1", firstName: "Grace", lastName: "Hopper", email: "grace@example.com", ordersCount: 5, totalSpent: "500.00", currencyCode: "USD", createdAt: "2026-05-18T12:00:00.000Z" },
  ],
  total: 4,
};

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json" },
  });
}

window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url === "/api/shopify/status") return jsonResponse(status);
  if (url.startsWith("/api/shopify/products") && init?.method !== "POST") return jsonResponse(products);
  if (url.startsWith("/api/shopify/orders")) return jsonResponse(orders);
  if (url === "/api/shopify/inventory") return jsonResponse(inventory);
  if (url.startsWith("/api/shopify/customers")) return jsonResponse(customers);
  if (url.includes("/api/shopify/inventory/")) return jsonResponse({ ok: true });
  return jsonResponse({ error: "Unexpected " + url }, { status: 404 });
};

const t = (_key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? "";

function EvidenceFrame({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="evidence-frame">
      <div className="evidence-label">{label}</div>
      <div className="evidence-surface">{children}</div>
    </section>
  );
}

function App() {
  return (
    <main className="evidence-page">
      <EvidenceFrame label="Native device controls">
        <DeviceSettingsAppView exitToApps={() => undefined} uiTheme="light" t={t} />
      </EvidenceFrame>
      <EvidenceFrame label="Plugin service dashboard">
        <ShopifyAppView exitToApps={() => undefined} uiTheme="light" t={t} />
      </EvidenceFrame>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
`,
  );
  await writeFile(
    path.join(srcDir, "evidence.css"),
    `
:root {
  --background: #f7f5f0;
  --bg: #fffaf2;
  --bg-muted: #eadfce;
  --txt: #201c18;
  --text: #201c18;
  --muted: #74675b;
  --muted-strong: #55483e;
  --accent: #e25f1a;
  --accent-foreground: #fff;
  --accent-subtle: rgba(226, 95, 26, 0.12);
  --ok: #2f8f55;
  --warn: #d99118;
  --danger: #d34835;
  --input: rgba(32, 28, 24, 0.18);
  --ring: rgba(226, 95, 26, 0.45);
}

html, body, #root {
  min-height: 100%;
}

body {
  margin: 0;
  background: var(--background);
  color: var(--txt);
  overflow: auto !important;
}

#root {
  display: block !important;
  height: auto !important;
  min-height: 100vh !important;
  overflow: visible !important;
}

button,
input,
select {
  font: inherit;
}

.evidence-page {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 24px;
  width: min(1320px, calc(100vw - 48px));
  margin: 0 auto;
  padding: 24px;
}

.evidence-frame {
  min-width: 0;
}

.evidence-label {
  margin: 0 0 10px;
  font-size: 12px;
  font-weight: 700;
  color: var(--muted-strong);
}

.evidence-surface {
  min-height: 1040px;
  overflow: hidden;
  background: var(--bg);
  box-shadow: 0 0 0 1px rgba(32, 28, 24, 0.08);
}

.evidence-surface > .fixed {
  position: relative !important;
  inset: auto !important;
  min-height: 1040px !important;
  height: auto !important;
}

@media (max-width: 900px) {
  .evidence-page {
    grid-template-columns: 1fr;
  }
}
`,
  );
  await writeFile(
    path.join(harnessDir, "vite.config.mjs"),
    `import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const repo = ${jsString(repoPath)};
const src = path.join(${jsString(harnessDir)}, "src");

export default defineConfig({
  root: ${jsString(harnessDir)},
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      { find: "@elizaos/ui/styles", replacement: path.join(repo, "packages/ui/src/styles.ts") },
      { find: "@elizaos/ui/agent-surface", replacement: path.join(src, "ui-stub.tsx") },
      { find: "@elizaos/ui/components/ui/tabs", replacement: path.join(src, "ui-stub.tsx") },
      { find: "@elizaos/ui/components", replacement: path.join(src, "ui-stub.tsx") },
      { find: "@elizaos/ui/app-navigate-view", replacement: path.join(src, "ui-stub.tsx") },
      { find: "@elizaos/ui", replacement: path.join(src, "ui-stub.tsx") },
      { find: "@elizaos/capacitor-system", replacement: path.join(src, "capacitor-system-stub.ts") },
      { find: "lucide-react", replacement: ${jsString(lucideReactPath)} },
      { find: "@xyflow/react/dist/style.css", replacement: ${jsString(xyflowReactStylePath)} },
      { find: "#device-settings", replacement: path.join(repo, "plugins/plugin-device-settings/src/components/DeviceSettingsAppView.tsx") },
      { find: "#shopify", replacement: path.join(repo, "plugins/plugin-shopify-ui/src/ShopifyAppView.tsx") },
    ],
  },
  server: {
    host: "127.0.0.1",
    fs: {
      allow: [repo, ${jsString(repoRoot)}, ${jsString(harnessDir)}],
    },
  },
});
`,
  );
}

async function capture(repoPath, label, options = {}) {
  const harnessDir = path.join(outDir, `.visual-harness-${label}`);
  await rm(harnessDir, { recursive: true, force: true });
  await mkdir(harnessDir, { recursive: true });
  await ensureNodeModulesLink(harnessDir);
  await writeHarnessFiles(harnessDir, repoPath);

  const server = await createServer({
    configFile: path.join(harnessDir, "vite.config.mjs"),
    server: { port: 0, strictPort: false },
    logLevel: "error",
  });
  await server.listen();
  const url = server.resolvedUrls.local[0];

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1200 },
    recordVideo: options.recordVideo
      ? { dir: outDir, size: { width: 1440, height: 1200 } }
      : undefined,
  });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => {
    consoleErrors.push(error.message);
  });

  await page.goto(url, { waitUntil: "networkidle" });
  await page.getByText("Eliza Store").first().waitFor({ timeout: 10_000 });
  await page.getByText("Device Settings").waitFor({ timeout: 10_000 });
  await page.screenshot({
    path: path.join(outDir, `9465-plugin-view-declutter-${label}.png`),
    fullPage: true,
  });

  let videoPath = null;
  if (options.recordVideo) {
    await page.getByRole("tab", { name: "Orders" }).click();
    await page.waitForTimeout(400);
    await page.getByRole("tab", { name: "Inventory" }).click();
    await page.waitForTimeout(400);
    await page.getByRole("tab", { name: "Customers" }).click();
    await page.waitForTimeout(400);
  }

  await context.close();
  if (options.recordVideo) {
    const videos = await page.video()?.path();
    if (videos) {
      videoPath = path.join(
        outDir,
        "9465-plugin-view-declutter-after-walkthrough.webm",
      );
      await rm(videoPath, { force: true });
      await import("node:fs/promises").then(({ rename }) =>
        rename(videos, videoPath),
      );
    }
  }
  await browser.close();
  await server.close();
  await rm(harnessDir, { recursive: true, force: true });

  return { label, consoleErrors, videoPath };
}

await mkdir(outDir, { recursive: true });

const results = [];
results.push(await capture(beforeRepo, "before"));
results.push(await capture(afterRepo, "after", { recordVideo: true }));

const manifest = {
  issue: 9465,
  beforeRepo,
  beforeCommit: gitCommit(beforeRepo),
  afterRepo,
  afterSourceCommit: gitCommit(afterRepo),
  generatedAt: new Date().toISOString(),
  artifacts: [
    "9465-plugin-view-declutter-before.png",
    "9465-plugin-view-declutter-after.png",
    "9465-plugin-view-declutter-after-walkthrough.webm",
  ],
  consoleErrors: Object.fromEntries(
    results.map((result) => [result.label, result.consoleErrors]),
  ),
  note: "Visual harness imports the real DeviceSettingsAppView and ShopifyAppView source files from each checkout. Native/system and Shopify APIs are deterministic fixture stubs matching the package tests.",
};

await writeFile(
  path.join(outDir, "9465-plugin-view-declutter-qa.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);

console.log(JSON.stringify(manifest, null, 2));
