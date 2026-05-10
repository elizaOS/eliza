#!/usr/bin/env bun
/**
 * launch-jup-studio — Solana token launch on Jupiter Studio (studio.jup.ag),
 * driven entirely through a real browser using the agent's wallet shim.
 *
 * End-to-end:
 *   1. boot the standalone wallet sign server (talks to the user's keypair)
 *   2. ask Cerebras (gpt-oss-120b) for token name / symbol / description
 *   3. launch Chromium with the Wallet-Standard + EIP-1193 shim auto-injected
 *   4. navigate → studio.jup.ag/launch
 *   5. click Connect → Eliza Wallet (sign-in-with-Solana via our shim's signMessage)
 *   6. choose Meme preset → fill basics → upload procedural PNG icon
 *   7. click Launch → our shim's signTransaction → on-chain mint
 *   8. report the mint signature & verify on-chain
 *
 * Optional:
 *   --buy <SOL amount>   immediately swap that much SOL into the freshly-launched
 *                         token via jup.ag (uses the same shim).
 *   --visit-flap         after launch, open flap.sh and confirm our EVM shim is
 *                         detected (no funds; just connection proof).
 *
 * Required env:
 *   SOLANA_PRIVATE_KEY   base58 secret of the funded keypair
 *   CEREBRAS_API_KEY     Cerebras API key for gpt-oss-120b token-meta generation
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Connection, PublicKey } from "@solana/web3.js";
import {
  type Browser,
  type BrowserContext,
  chromium,
  type Locator,
  type Page,
} from "playwright";
import { buildWalletShim } from "../../plugins/plugin-wallet/src/browser-shim/build-shim.ts";
import { decideTokenMeta, type TokenMeta } from "./cerebras-driver.ts";
import { makeSolidPng } from "./png-util.ts";
import { startSignServer } from "./sign-server.ts";

interface Flags {
  brief: string;
  buySol: number; // 0 = no buy
  visitFlap: boolean;
  headed: boolean;
  rpc: string;
  signToken: string;
  dryRun: boolean;
  slow: number;
}

function parseFlags(argv: string[]): Flags {
  const valueOf = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    brief:
      valueOf("--brief") ??
      "a tiny memecoin celebrating sentient toasters that achieve enlightenment by burning the perfect bagel — wholesome, brief, internet-native",
    buySol: Number(valueOf("--buy") ?? "0"),
    visitFlap: argv.includes("--visit-flap"),
    headed: argv.includes("--headed") || !process.env.CI,
    rpc:
      valueOf("--rpc") ??
      process.env.SOLANA_RPC_URL ??
      "https://api.mainnet-beta.solana.com",
    signToken:
      process.env.WALLET_BROWSER_SIGN_TOKEN ??
      `eliza-wallet-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    dryRun: argv.includes("--dry-run"),
    slow: Number(valueOf("--slow") ?? "0"),
  };
}

const c = {
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};
const log = (label: string, ...rest: unknown[]) =>
  console.log(c.cyan(`[${label}]`), ...rest);
const warn = (label: string, ...rest: unknown[]) =>
  console.log(c.yellow(`[${label}]`), ...rest);
const ok = (label: string, ...rest: unknown[]) =>
  console.log(c.green(`[${label}]`), ...rest);
const err = (label: string, ...rest: unknown[]) =>
  console.error(c.red(`[${label}]`), ...rest);

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env: ${name}`);
  return v;
}

async function clickIfVisible(
  page: Page,
  loc: Locator,
  what: string,
  timeoutMs = 1500,
): Promise<boolean> {
  try {
    if (await loc.first().isVisible({ timeout: timeoutMs })) {
      await loc.first().click();
      log("click", what);
      return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

async function clickByText(
  page: Page,
  texts: string[],
  what: string,
  opts: { exact?: boolean; timeoutMs?: number } = {},
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 8000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const t of texts) {
      const re = opts.exact
        ? new RegExp("^" + t + "$", "i")
        : new RegExp(t, "i");
      for (const role of ["button", "link"] as const) {
        try {
          const loc = page.getByRole(role, { name: re });
          if (await loc.first().isVisible({ timeout: 300 })) {
            await loc.first().click();
            log("click", `${what} ← role=${role} text=${JSON.stringify(t)}`);
            return true;
          }
        } catch {
          /* ignore */
        }
      }
      try {
        const loc = page.locator(`text=${t}`).first();
        if (await loc.isVisible({ timeout: 300 })) {
          await loc.click();
          log("click", `${what} ← text=${JSON.stringify(t)}`);
          return true;
        }
      } catch {
        /* ignore */
      }
    }
    await page.waitForTimeout(400);
  }
  warn("click", `${what}: no match for ${JSON.stringify(texts)}`);
  return false;
}

async function fillByLabel(
  page: Page,
  labels: string[],
  value: string,
  what: string,
): Promise<boolean> {
  for (const label of labels) {
    const re = new RegExp(label, "i");
    for (const fn of [
      () => page.getByLabel(re),
      () => page.getByPlaceholder(re),
    ]) {
      try {
        const loc = fn();
        if (await loc.first().isVisible({ timeout: 800 })) {
          await loc.first().fill(value);
          log("fill", `${what} ← ${JSON.stringify(value).slice(0, 80)}`);
          return true;
        }
      } catch {
        /* ignore */
      }
    }
    // try by id (jup uses id="name", id="ticker")
    try {
      const loc = page.locator(`#${label.toLowerCase()}`);
      if (await loc.first().isVisible({ timeout: 500 })) {
        await loc.first().fill(value);
        log("fill", `${what} ← #${label} ← ${JSON.stringify(value).slice(0, 60)}`);
        return true;
      }
    } catch {
      /* ignore */
    }
  }
  warn("fill", `${what}: no input matched ${JSON.stringify(labels)}`);
  return false;
}

async function snapshotForms(page: Page, label: string): Promise<void> {
  const buttons = await page
    .locator("button, a[href]")
    .evaluateAll((els) =>
      els
        .map((el) => ({
          tag: el.tagName,
          text: (el.textContent ?? "").trim().slice(0, 60),
          aria: el.getAttribute("aria-label"),
        }))
        .filter((b) => b.text.length > 0 || b.aria),
    );
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
          ph: e.placeholder,
          aria: e.getAttribute("aria-label"),
        };
      }),
    );
  console.log(`\n=== snapshot/${label} buttons (40) ===`);
  console.log(JSON.stringify(buttons.slice(0, 40), null, 2));
  console.log(`\n=== snapshot/${label} inputs ===`);
  console.log(JSON.stringify(inputs, null, 2));
}

interface LaunchResult {
  mint?: string;
  signature?: string;
  url?: string;
}

async function connectWallet(page: Page, shotDir: string): Promise<boolean> {
  log("wallet", "opening Connect modal …");
  await clickByText(page, ["^Connect$"], "open connect modal", {
    timeoutMs: 8000,
  });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(shotDir, "01-connect-modal.png") });

  // The modal lists "Installed" wallets first; ours appears as "Eliza Wallet".
  // Some Wallet-Standard adapters show an icon-only button; if a text match
  // doesn't catch it, fall back to the first button in the modal whose alt-text
  // mentions "eliza" or whose accessible name matches.
  const candidates = ["Eliza Wallet", "Eliza"];
  for (const t of candidates) {
    if (
      await clickByText(page, [t], `pick ${t}`, {
        exact: true,
        timeoutMs: 4000,
      })
    ) {
      await page.waitForTimeout(2000);
      // Some flows expand a "View More Wallets" sheet — try unhide + click again.
      return true;
    }
  }
  warn("wallet", "Eliza Wallet not directly clickable; expanding 'View More'");
  await clickByText(page, ["View More Wallets", "More wallets"], "expand wallet list", {
    timeoutMs: 3000,
  });
  await page.waitForTimeout(800);
  for (const t of candidates) {
    if (
      await clickByText(page, [t], `pick ${t} (expanded)`, {
        exact: true,
        timeoutMs: 4000,
      })
    ) {
      await page.waitForTimeout(2000);
      return true;
    }
  }
  // last resort — find by image alt or aria-label inside the modal
  const found = await page
    .locator(
      "[role='dialog'] button, [role='dialog'] [role='button'], [aria-label*='Eliza' i]",
    )
    .evaluateAll((els) =>
      els.map((el) => ({
        text: (el.textContent ?? "").trim(),
        aria: el.getAttribute("aria-label"),
        alt:
          el.querySelector("img")?.getAttribute("alt") ??
          el.querySelector("[alt]")?.getAttribute("alt") ??
          null,
      })),
    );
  console.log("modal entries:", JSON.stringify(found, null, 2));
  return false;
}

async function launchOnJupStudio(
  page: Page,
  meta: TokenMeta,
  iconPath: string,
  flags: Flags,
  shotDir: string,
): Promise<LaunchResult> {
  log("nav", "→ studio.jup.ag/launch");
  await page.goto("https://studio.jup.ag/launch", {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await page.waitForTimeout(4000);
  await page.screenshot({ path: path.join(shotDir, "00-landed.png") });

  // 1. dismiss any cookie / age confirmations
  for (const t of ["Accept all", "I agree", "Continue", "OK"]) {
    if (
      await clickByText(page, [t], `dismiss "${t}"`, {
        exact: true,
        timeoutMs: 1500,
      })
    ) {
      await page.waitForTimeout(800);
    }
  }

  // 2. connect wallet
  if (!(await connectWallet(page, shotDir))) {
    warn("wallet", "could not connect; dumping modal state");
    await snapshotForms(page, "connect-fail");
  }
  await page.waitForTimeout(2000);

  // 3. some adapters fire a SIWS prompt; our shim auto-signs without UI, so
  //    nothing visible. Just give the page a moment to settle into "connected".
  await page.screenshot({ path: path.join(shotDir, "02-after-connect.png") });

  // 4. choose the Meme preset (the snapshot showed: "🐸 Meme  5K -> 75K USDC")
  if (
    !(await clickByText(page, ["Meme"], "choose Meme preset", {
      timeoutMs: 6000,
    }))
  ) {
    warn("preset", "Meme preset not found, trying Custom");
    await clickByText(page, ["Custom"], "fall back to Custom", {
      timeoutMs: 4000,
    });
  }
  await page.waitForTimeout(2000);
  await page.screenshot({ path: path.join(shotDir, "03-preset.png") });

  // 5. fill basics — ids match pump.fun's: name, ticker, description
  await fillByLabel(page, ["name", "Name your"], meta.name, "name");
  await fillByLabel(
    page,
    ["ticker", "symbol", "Add a coin ticker"],
    meta.symbol,
    "ticker",
  );
  await fillByLabel(
    page,
    ["description", "Write a short description"],
    meta.description,
    "description",
  );

  // upload icon
  try {
    const fileInputs = page.locator("input[type=file]");
    if ((await fileInputs.count()) > 0) {
      await fileInputs.first().setInputFiles(iconPath);
      log("upload", `icon → ${path.basename(iconPath)}`);
    }
  } catch (e) {
    warn("upload", (e as Error).message);
  }

  if (meta.twitter)
    await fillByLabel(page, ["twitter", "x.com"], meta.twitter, "twitter");
  if (meta.telegram)
    await fillByLabel(page, ["telegram"], meta.telegram, "telegram");
  if (meta.website)
    await fillByLabel(page, ["website"], meta.website, "website");

  await page.screenshot({ path: path.join(shotDir, "04-filled.png") });

  if (flags.dryRun) {
    warn("dry-run", "stopping before final launch click");
    return {};
  }

  // 6. progress through Studio's stepper. Snapshot showed "1. Basics", "2. Enhance".
  for (const t of ["Next", "Continue", "Enhance"]) {
    await clickByText(page, [t], `step → "${t}"`, {
      timeoutMs: 3000,
      exact: true,
    });
    await page.waitForTimeout(1500);
  }
  await page.screenshot({ path: path.join(shotDir, "05-step2.png") });

  // 7. launch
  if (
    !(await clickByText(
      page,
      ["Launch", "Create coin", "Create token", "Launch token", "Confirm"],
      "click launch",
      { timeoutMs: 8000 },
    ))
  ) {
    warn("launch", "no launch button found; dumping snapshot");
    await snapshotForms(page, "launch-fail");
    return {};
  }

  // 8. wait for tx confirmation; success = redirect to a token page or the URL
  //    contains a 32+ base58 mint. If that doesn't happen within 90s, fail.
  log("launch", "transaction in flight; watching for confirmation …");
  const success = await page
    .waitForURL(/[A-Za-z1-9]{32,44}/, { timeout: 120_000 })
    .then(() => true)
    .catch(() => false);
  await page.screenshot({ path: path.join(shotDir, "06-after-launch.png") });

  const url = page.url();
  const mintMatch = url.match(/([1-9A-HJ-NP-Za-km-z]{32,44})/);
  if (success && mintMatch) {
    return { mint: mintMatch[1], url };
  }
  warn("launch", "no mint in URL within 120s. URL:", url);
  return { url };
}

async function buyOnJupiter(
  page: Page,
  mint: string,
  solAmount: number,
  shotDir: string,
): Promise<{ signature?: string }> {
  log("buy", `→ jup.ag swap SOL → ${mint} amount=${solAmount}`);
  // Jupiter's swap UI accepts the output mint as a query param.
  const url = `https://jup.ag/swap/SOL-${mint}`;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(4000);
  await page.screenshot({ path: path.join(shotDir, "buy-00-landed.png") });

  // connect wallet (same shim wallet)
  await connectWallet(page, shotDir);
  await page.waitForTimeout(2000);
  await page.screenshot({ path: path.join(shotDir, "buy-01-connected.png") });

  // fill amount in the SOL "you pay" input
  const amountStr = solAmount.toString();
  // Jupiter v3 uses an input with placeholder "0.00" or aria-label "amount-in"
  const filled = await fillByLabel(
    page,
    ["You're selling", "amount", "0.00", "Sell", "Pay"],
    amountStr,
    "amount in",
  );
  if (!filled) {
    warn("buy", "could not find amount input — snapshotting");
    await snapshotForms(page, "jup-buy");
  }
  await page.waitForTimeout(1500);

  if (
    !(await clickByText(
      page,
      ["Swap", "Confirm Swap", "Buy"],
      "click swap",
      { timeoutMs: 8000 },
    ))
  ) {
    warn("buy", "no swap button");
    return {};
  }

  // approve in wallet (signTransaction via shim — automatic)
  await page.waitForTimeout(8000);
  await page.screenshot({ path: path.join(shotDir, "buy-02-after-swap.png") });

  // Look for a tx-confirmed banner
  const ok = await page
    .locator("text=/Confirmed|Successful|Swap complete|Transaction Sent/i")
    .first()
    .isVisible({ timeout: 90_000 })
    .catch(() => false);
  return ok ? { signature: "confirmed (signature in toast)" } : {};
}

async function visitFlap(page: Page, shotDir: string): Promise<void> {
  log("flap", "→ flap.sh (BNB chain detection)");
  await page.goto("https://flap.sh/", {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });
  await page.waitForTimeout(4000);
  await page.screenshot({ path: path.join(shotDir, "flap-00.png") });

  const status = await page.evaluate(() => {
    const w = window as unknown as {
      ethereum?: { isMetaMask?: boolean; request: (a: { method: string }) => Promise<unknown> };
    };
    return {
      hasEthereum: !!w.ethereum,
      isMetaMask: w.ethereum?.isMetaMask ?? false,
    };
  });
  log("flap", `EVM provider visible: ${JSON.stringify(status)}`);

  // Some flap pages auto-connect on detection. Check the top-right pill.
  const addressPill = await page
    .locator("button:has-text('0x')")
    .first()
    .textContent({ timeout: 5000 })
    .catch(() => null);
  if (addressPill) {
    ok("flap", `auto-connected pill: ${addressPill.trim()}`);
  } else {
    log("flap", "no auto-connect pill; trying explicit Connect");
    await clickByText(page, ["Connect", "Sign in"], "flap connect", {
      timeoutMs: 4000,
    });
    await page.waitForTimeout(2000);
  }
  await page.screenshot({ path: path.join(shotDir, "flap-01-connected.png") });
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const cerebrasKey = requireEnv("CEREBRAS_API_KEY");
  const solanaKey = requireEnv("SOLANA_PRIVATE_KEY");
  const evmKey =
    (process.env.EVM_PRIVATE_KEY as `0x${string}` | undefined) ??
    (("0x" + "11".repeat(32)) as `0x${string}`); // throwaway for shim

  const shotDir = path.join(
    "/tmp",
    `eliza-launch-${new Date().toISOString().replace(/[:.]/g, "-")}`,
  );
  fs.mkdirSync(shotDir, { recursive: true });
  log("env", `rpc=${flags.rpc} headed=${flags.headed} screenshots=${shotDir}`);
  log("brief", flags.brief);

  // 1. boot sign server
  const signer = await startSignServer({
    port: 0,
    signToken: flags.signToken,
    solanaSecretKeyBase58: solanaKey,
    evmPrivateKey: evmKey,
    solanaRpcUrl: flags.rpc,
  });
  ok("sign-server", `up at ${signer.url} (sol=${signer.solanaPublicKey})`);

  const conn = new Connection(flags.rpc, "confirmed");
  const lamports = await conn.getBalance(new PublicKey(signer.solanaPublicKey!));
  const sol = lamports / 1e9;
  log("balance", `${sol.toFixed(4)} SOL`);
  if (sol < 0.03) warn("balance", "<0.03 SOL — launch + buy may fail");

  // 2. cerebras meta
  log("cerebras", "→ gpt-oss-120b");
  const meta = await decideTokenMeta({ brief: flags.brief, apiKey: cerebrasKey });
  ok("meta", JSON.stringify(meta, null, 2));

  // 3. icon
  const iconPath = path.join(
    os.tmpdir(),
    `eliza-${meta.symbol.toLowerCase()}.png`,
  );
  const seed = [...meta.symbol].reduce(
    (a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0,
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
  ok("icon", iconPath);

  // 4. shim
  const shim = buildWalletShim({
    apiBase: signer.url,
    signToken: flags.signToken,
    solanaPublicKey: signer.solanaPublicKey,
    evmAddress: signer.evmAddress,
    evmChainId: 56, // BNB chain — flap.sh's default; jup.ag is Solana-only and ignores this
    walletName: "Eliza Wallet",
    evmRpcByChainId: {
      "1": "https://eth.llamarpc.com",
      "8453": "https://mainnet.base.org",
      "56": "https://bsc-dataseed.bnbchain.org",
    },
  });
  log("shim", `${shim.length} bytes`);

  // 5. browser
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
      if (
        t === "error" ||
        /eliza_wallet|wallet-standard|signTransaction|signMessage|connect/i.test(
          txt,
        )
      ) {
        console.log(`  [page/${t}]`, txt.slice(0, 250));
      }
    });
    page.on("pageerror", (e) => err("page-error", e.message.slice(0, 250)));

    // --- launch ---
    const launchResult = await launchOnJupStudio(
      page,
      meta,
      iconPath,
      flags,
      shotDir,
    );
    if (launchResult.mint) {
      ok("LAUNCHED", `mint=${launchResult.mint}`);
      ok("LAUNCHED", `studio: ${launchResult.url}`);
      ok("LAUNCHED", `solscan: https://solscan.io/token/${launchResult.mint}`);
      try {
        const info = await conn.getAccountInfo(new PublicKey(launchResult.mint));
        ok(
          "verify",
          info
            ? `on-chain owner=${info.owner.toBase58()} lamports=${info.lamports}`
            : "not yet visible on RPC",
        );
      } catch (e) {
        warn("verify", (e as Error).message);
      }

      if (flags.buySol > 0) {
        const buyResult = await buyOnJupiter(
          page,
          launchResult.mint,
          flags.buySol,
          shotDir,
        );
        if (buyResult.signature) {
          ok("BOUGHT", buyResult.signature);
        } else {
          warn("BOUGHT", "buy did not confirm — check screenshots");
        }
      }
    } else {
      err("LAUNCH FAILED", "no mint produced — see screenshots in", shotDir);
    }

    if (flags.visitFlap) {
      await visitFlap(page, shotDir);
    }

    if (flags.headed) {
      warn("hold", "leaving browser open 60s for inspection. Ctrl-C to exit.");
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
