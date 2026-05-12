#!/usr/bin/env bun
/**
 * launch-pumpfun — End-to-end wallet/browser smoke test.
 *
 * Boots the standalone wallet sign server, launches Chromium with the
 * Wallet-Standard + EIP-1193 shim auto-injected via `addInitScript`, asks
 * Cerebras (gpt-oss-120b) to invent token metadata for a free-form brief,
 * walks the pump.fun create-coin flow, signs the transaction through the
 * agent's keypair, and reports the resulting mint signature.
 *
 * Usage:
 *   SOLANA_PRIVATE_KEY=<base58> CEREBRAS_API_KEY=<csk-…> \
 *     bun run scripts/wallet-browser/launch-pumpfun.ts \
 *       --brief "a memecoin about …" \
 *       [--headed] [--dry-run] [--rpc <https://...>]
 *
 * Flags:
 *   --brief   Free-form pitch the LLM expands into name/symbol/description.
 *   --dry-run Stop just before the final "Create coin" click. Useful when
 *             iterating on selectors — leaves the browser open for inspection.
 *   --headed  Run with a visible window (default headless when CI=1, else headed).
 *   --rpc     Override `SOLANA_RPC_URL` for the sign server.
 *   --slow    Add a 250ms delay between actions for readability.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Connection, PublicKey } from "@solana/web3.js";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright";
import { buildWalletShim } from "../../plugins/plugin-wallet/src/browser-shim/build-shim.ts";
import { decideTokenMeta, type TokenMeta } from "./cerebras-driver.ts";
import { makeSolidPng } from "./png-util.ts";
import { startSignServer, type SignServerHandle } from "./sign-server.ts";

interface CliFlags {
  brief: string;
  dryRun: boolean;
  headed: boolean;
  rpc: string;
  slow: number;
  signToken: string;
}

function parseFlags(argv: string[]): CliFlags {
  const brief =
    valueOf(argv, "--brief") ??
    "a memecoin about a sentient toaster discovering enlightenment by burning the perfect bagel — wholesome, internet-native, brief";
  const dryRun = argv.includes("--dry-run");
  const headed = argv.includes("--headed") || !process.env.CI;
  const rpc =
    valueOf(argv, "--rpc") ??
    process.env.SOLANA_RPC_URL ??
    "https://api.mainnet-beta.solana.com";
  const slowStr = valueOf(argv, "--slow");
  const slow = slowStr ? Number(slowStr) : 0;
  const signToken =
    process.env.WALLET_BROWSER_SIGN_TOKEN ??
    `eliza-wallet-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return { brief, dryRun, headed, rpc, slow, signToken };
}

function valueOf(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  if (i === -1) return undefined;
  return argv[i + 1];
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env: ${name}`);
  return v;
}

const log = (label: string, ...rest: unknown[]) =>
  console.log(`\x1b[36m[${label}]\x1b[0m`, ...rest);
const warn = (label: string, ...rest: unknown[]) =>
  console.log(`\x1b[33m[${label}]\x1b[0m`, ...rest);
const ok = (label: string, ...rest: unknown[]) =>
  console.log(`\x1b[32m[${label}]\x1b[0m`, ...rest);
const err = (label: string, ...rest: unknown[]) =>
  console.error(`\x1b[31m[${label}]\x1b[0m`, ...rest);

async function ensureBalance(rpc: string, pubkey: string): Promise<number> {
  const conn = new Connection(rpc, "confirmed");
  const lamports = await conn.getBalance(new PublicKey(pubkey));
  return lamports / 1e9;
}

async function safeClickByText(
  page: Page,
  texts: string[],
  opts?: { timeoutMs?: number },
): Promise<boolean> {
  const timeoutMs = opts?.timeoutMs ?? 8000;
  const deadline = Date.now() + timeoutMs;
  for (const t of texts) {
    while (Date.now() < deadline) {
      try {
        const button = page.getByRole("button", { name: new RegExp(t, "i") });
        if (await button.first().isVisible({ timeout: 500 })) {
          await button.first().click();
          log("click", `matched "${t}"`);
          return true;
        }
      } catch {
        // ignore
      }
      try {
        const link = page.getByRole("link", { name: new RegExp(t, "i") });
        if (await link.first().isVisible({ timeout: 500 })) {
          await link.first().click();
          log("click", `matched link "${t}"`);
          return true;
        }
      } catch {
        // ignore
      }
      try {
        const generic = page.locator(`text=${t}`).first();
        if (await generic.isVisible({ timeout: 500 })) {
          await generic.click();
          log("click", `matched text "${t}"`);
          return true;
        }
      } catch {
        // ignore
      }
      await page.waitForTimeout(300);
    }
  }
  return false;
}

async function fillByLabel(
  page: Page,
  labels: string[],
  value: string,
): Promise<boolean> {
  for (const label of labels) {
    try {
      const input = page.getByLabel(new RegExp(label, "i"));
      if (await input.first().isVisible({ timeout: 1000 })) {
        await input.first().fill(value);
        log("fill", `${label} ← "${value.slice(0, 40)}"`);
        return true;
      }
    } catch {
      // ignore
    }
    try {
      const placeholder = page.getByPlaceholder(new RegExp(label, "i"));
      if (await placeholder.first().isVisible({ timeout: 1000 })) {
        await placeholder.first().fill(value);
        log("fill", `${label} (placeholder) ← "${value.slice(0, 40)}"`);
        return true;
      }
    } catch {
      // ignore
    }
  }
  return false;
}

async function snapshotForms(page: Page): Promise<void> {
  const inputs = await page
    .locator("input, textarea")
    .evaluateAll((els) =>
      els.map((el) => {
        const e = el as HTMLInputElement;
        return {
          tag: e.tagName,
          type: e.type,
          name: e.name,
          id: e.id,
          placeholder: e.placeholder,
          ariaLabel: e.getAttribute("aria-label"),
        };
      }),
    );
  console.log("[snapshot/inputs]", JSON.stringify(inputs, null, 2));
  const buttons = await page
    .locator("button, a[href]")
    .evaluateAll((els) =>
      els
        .map((el) => ({
          tag: el.tagName,
          text: (el.textContent ?? "").trim().slice(0, 60),
          ariaLabel: el.getAttribute("aria-label"),
          href: el.getAttribute("href"),
        }))
        .filter((b) => b.text.length > 0 || b.ariaLabel),
    );
  console.log("[snapshot/buttons]", JSON.stringify(buttons.slice(0, 40), null, 2));
}

async function drivePumpFun(
  page: Page,
  meta: TokenMeta,
  iconPath: string,
  flags: CliFlags,
): Promise<{ mint?: string; signature?: string }> {
  log("nav", "→ https://pump.fun/create");
  await page.goto("https://pump.fun/create", {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });

  // 1. dismiss any age/cookie/intro modal
  await page.waitForTimeout(2000);
  for (const txt of [
    "I'm ready to pump",
    "I am 18",
    "Accept",
    "Got it",
    "Continue",
  ]) {
    if (
      await safeClickByText(page, [txt], { timeoutMs: 2000 }).catch(() => false)
    ) {
      await page.waitForTimeout(800);
      break;
    }
  }

  // 2. fill name / ticker / description
  const filledName = await fillByLabel(page, ["name"], meta.name);
  const filledSymbol = await fillByLabel(
    page,
    ["ticker", "symbol"],
    meta.symbol,
  );
  const filledDesc = await fillByLabel(
    page,
    ["description"],
    meta.description,
  );
  if (!filledName || !filledSymbol || !filledDesc) {
    warn("form", "some fields not found — dumping form snapshot");
    await snapshotForms(page);
  }

  // 3. upload icon
  try {
    const fileInputs = page.locator("input[type=file]");
    const count = await fileInputs.count();
    if (count > 0) {
      await fileInputs.first().setInputFiles(iconPath);
      log("upload", `icon → ${path.basename(iconPath)}`);
    } else {
      warn("upload", "no <input type=file> found");
    }
  } catch (e) {
    warn("upload", "icon upload failed:", (e as Error).message);
  }

  // 4. optional socials
  if (meta.twitter) await fillByLabel(page, ["twitter", "x.com"], meta.twitter);
  if (meta.telegram) await fillByLabel(page, ["telegram"], meta.telegram);
  if (meta.website) await fillByLabel(page, ["website"], meta.website);

  if (flags.slow) await page.waitForTimeout(flags.slow);

  // 5. click "Create coin" / "Launch" — this triggers wallet flow
  const clickedCreate = await safeClickByText(
    page,
    ["Create coin", "Launch coin", "Create token", "Launch token", "Create"],
    { timeoutMs: 10_000 },
  );
  if (!clickedCreate) {
    warn("create", "couldn't find a create button");
    await snapshotForms(page);
    return {};
  }

  if (flags.dryRun) {
    warn("dry-run", "stopping before wallet popup. Browser left open for inspection.");
    return {};
  }

  // 6. Wallet-adapter modal: select Eliza Wallet
  log("wallet", "waiting for wallet-adapter modal …");
  const adapterClicked = await safeClickByText(
    page,
    ["Eliza Wallet"],
    { timeoutMs: 15_000 },
  );
  if (!adapterClicked) {
    warn("wallet", "didn't find Eliza Wallet in adapter list");
    await snapshotForms(page);
  }

  // 7. some flows show a "I want to buy some?" prompt — dismiss/keep at 0
  await page.waitForTimeout(1500);

  // 8. wait for the URL to redirect to /coin/<mint> — that's success
  const success = await page
    .waitForURL(/\/coin\/[A-Za-z0-9]{32,}/, { timeout: 90_000 })
    .then(() => true)
    .catch(() => false);

  if (success) {
    const url = page.url();
    const mintMatch = url.match(/\/coin\/([A-Za-z0-9]{32,})/);
    return { mint: mintMatch?.[1] };
  }

  warn("create", "no /coin/<mint> redirect within 90s. URL:", page.url());
  return {};
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const cerebrasKey = requireEnv("CEREBRAS_API_KEY");
  const solanaKey = requireEnv("SOLANA_PRIVATE_KEY");

  log("env", `rpc=${flags.rpc} headed=${flags.headed} dryRun=${flags.dryRun}`);
  log("brief", flags.brief);

  // --- 1. boot wallet sign server ---
  const signer = await startSignServer({
    port: 0,
    signToken: flags.signToken,
    solanaSecretKeyBase58: solanaKey,
    solanaRpcUrl: flags.rpc,
  });
  ok("sign-server", `up at ${signer.url} (sol=${signer.solanaPublicKey})`);

  // sanity: balance
  const bal = await ensureBalance(flags.rpc, signer.solanaPublicKey!);
  log("balance", `${bal.toFixed(4)} SOL`);
  if (bal < 0.025) {
    warn("balance", "<0.025 SOL — pump.fun launches typically need ~0.02+");
  }

  // --- 2. cerebras: invent token metadata ---
  log("cerebras", "asking gpt-oss-120b for token metadata …");
  const meta = await decideTokenMeta({
    brief: flags.brief,
    apiKey: cerebrasKey,
  });
  ok("meta", JSON.stringify(meta, null, 2));

  // --- 3. generate placeholder icon ---
  const iconPath = path.join(os.tmpdir(), `eliza-${meta.symbol.toLowerCase()}.png`);
  // colour seeded from symbol so icons are visually distinct between runs
  const seed = [...meta.symbol].reduce(
    (acc, c) => (acc * 31 + c.charCodeAt(0)) >>> 0,
    0,
  );
  fs.writeFileSync(
    iconPath,
    makeSolidPng({
      width: 512,
      height: 512,
      rgba: [
        80 + (seed % 150),
        80 + ((seed >> 8) % 150),
        80 + ((seed >> 16) % 150),
        255,
      ],
    }),
  );
  ok("icon", `wrote ${iconPath}`);

  // --- 4. build shim ---
  const shim = buildWalletShim({
    apiBase: signer.url,
    signToken: flags.signToken,
    solanaPublicKey: signer.solanaPublicKey,
    evmAddress: signer.evmAddress,
    evmChainId: 1,
  });
  log("shim", `${shim.length} bytes`);

  // --- 5. launch chromium ---
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let page: Page | undefined;
  try {
    browser = await chromium.launch({
      headless: !flags.headed,
      args: ["--disable-blink-features=AutomationControlled"],
    });
    context = await browser.newContext({
      viewport: { width: 1366, height: 900 },
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
    });
    await context.addInitScript({ content: shim });
    page = await context.newPage();
    page.on("console", (msg) => {
      const t = msg.type();
      const txt = msg.text();
      if (t === "error" || /wallet|solana|ethereum/i.test(txt)) {
        console.log(`[page/${t}]`, txt.slice(0, 400));
      }
    });
    page.on("pageerror", (e) => err("page-error", e.message));

    const result = await drivePumpFun(page, meta, iconPath, flags);

    if (result.mint) {
      ok("LAUNCHED", `mint=${result.mint}`);
      ok("LAUNCHED", `https://pump.fun/coin/${result.mint}`);
      ok("LAUNCHED", `https://solscan.io/token/${result.mint}`);

      // Verify on-chain
      try {
        const conn = new Connection(flags.rpc, "confirmed");
        const info = await conn.getAccountInfo(new PublicKey(result.mint));
        ok(
          "verify",
          info ? `on-chain account exists, owner=${info.owner.toBase58()}` : "not yet visible on RPC",
        );
      } catch (e) {
        warn("verify", (e as Error).message);
      }
    } else {
      err("FAILED", "no mint produced (see logs above)");
    }

    if (flags.headed && (flags.dryRun || !result.mint)) {
      warn("hold", "leaving browser open for 60s — Ctrl-C to exit");
      await page.waitForTimeout(60_000);
    }
  } finally {
    await page?.close().catch(() => {});
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await signer.close().catch(() => {});
  }
}

main().catch((e) => {
  err("fatal", e instanceof Error ? e.stack : String(e));
  process.exit(1);
});
