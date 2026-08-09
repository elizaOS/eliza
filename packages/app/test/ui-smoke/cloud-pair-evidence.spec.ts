/**
 * Real-browser relaunch/storage evidence for #17579.
 *
 * Runs the REAL production boot adopter (`applyCloudPairSessionToken` in
 * packages/app/src/main.tsx) and the REAL credential modules (cloud-pair-token,
 * CloudPairRelay, persistence) in headless Chromium against the smoke stack's
 * origin, with the REAL localStorage/sessionStorage. No jsdom, no module mocks.
 *
 * The smoke stack serves the BUILT renderer (there is no dev-server module
 * graph to dynamic-import from), so the real modules are bundled from their
 * repo sources with esbuild at spec runtime — the same technique the reviewed
 * accounts-ui e2e uses — and injected into the page as one script. The boot
 * adopter source is extracted from the repo's main.tsx — the exact extraction
 * the reviewed unit test (`cloud-pair-session-token.test.ts`) performs — and
 * executed in the page with the real module collaborators bound in. This is a
 * browser-real execution of production code, not a reimplementation.
 *
 * Evidence captured (saved under test-results/cloud-pair-evidence/):
 *   - storage-dump-<phase>.json   full localStorage+sessionStorage key/value dump
 *   - <phase>.png                 full-page screenshot at each phase
 *   - MANIFEST.md                 summary of phases + assertions
 *
 * Run with:
 *   ELIZA_UI_SMOKE_REUSE_SERVER=1 bun x playwright test cloud-pair-evidence --config playwright.ui-smoke.config.ts
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { build, type Plugin as EsbuildPlugin, transform } from "esbuild";

const HERE = dirname(fileURLToPath(import.meta.url));
// HERE = packages/app/test/ui-smoke → up 2 = packages/app
const APP_DIR = resolve(HERE, "..", "..");
const REPO_ROOT = resolve(APP_DIR, "..", "..");
const OUT_DIR = resolve(APP_DIR, "test-results", "cloud-pair-evidence");

/**
 * Bundle the REAL production modules (plus react/react-dom for the render
 * test) from their repo sources into one browser IIFE exposing
 * `window.__cloudPairEvidenceModules`. Built once per worker; esbuild only
 * bundles — the module code under test is the checked-in production source.
 */
let evidenceBundlePromise: Promise<string> | null = null;
function evidenceModulesBundle(): Promise<string> {
  evidenceBundlePromise ??= (async () => {
    const ui = join(REPO_ROOT, "packages", "ui", "src");
    // Node-builtin imports reached through transitive dependency chains become
    // inert proxies (mirrors the reviewed accounts-ui e2e bundler): the
    // modules under test are browser storage/auth code and never call them.
    const nodeBuiltins = new Set([
      ...builtinModules,
      ...builtinModules.map((name) => `node:${name}`),
    ]);
    // `@elizaos/core` is never imported by the modules under test (verified —
    // it only enters transitively through i18n/api barrel collaterals), and
    // its plugin-manager subtree is node-only, so the whole package becomes an
    // inert proxy as well.
    const stubElizaCore: EsbuildPlugin = {
      name: "stub-eliza-core",
      setup(b) {
        b.onResolve({ filter: /^@elizaos\/core(\/.*)?$/ }, (args) => ({
          path: args.path,
          namespace: "eliza-core-stub",
        }));
        b.onLoad({ filter: /.*/, namespace: "eliza-core-stub" }, () => ({
          contents:
            "const n=()=>noop;const noop=new Proxy(n,{get:()=>noop});module.exports=noop;",
          loader: "js",
        }));
      },
    };
    const stubNodeBuiltins: EsbuildPlugin = {
      name: "stub-node-builtins",
      setup(b) {
        b.onResolve({ filter: /.*/ }, (args) => {
          const bare = args.path.replace(/^node:/, "").split("/")[0] ?? "";
          if (
            args.path.startsWith("node:") ||
            nodeBuiltins.has(args.path) ||
            builtinModules.includes(bare)
          ) {
            return { path: args.path, namespace: "node-stub" };
          }
          return null;
        });
        b.onLoad({ filter: /.*/, namespace: "node-stub" }, () => ({
          contents:
            "const n=()=>noop;const noop=new Proxy(n,{get:()=>noop});module.exports=noop;",
          loader: "js",
        }));
      },
    };
    const entry = [
      `export * as relay from ${JSON.stringify(join(ui, "components/auth/CloudPairRelay.tsx"))};`,
      `export * as tokenState from ${JSON.stringify(join(ui, "state/cloud-pair-token.ts"))};`,
      `export * as persistence from ${JSON.stringify(join(ui, "state/persistence.ts"))};`,
      `export * as agentRecovery from ${JSON.stringify(join(ui, "state/agent-session-recovery.ts"))};`,
      `export * as agentProfiles from ${JSON.stringify(join(ui, "state/agent-profiles.ts"))};`,
      `export * as cloudAgentBase from ${JSON.stringify(join(ui, "utils/cloud-agent-base.ts"))};`,
      `export * as realm from ${JSON.stringify(join(ui, "surface-realm-channel.ts"))};`,
      `export * as react from "react";`,
      `export * as reactDomClient from "react-dom/client";`,
    ].join("\n");
    const result = await build({
      stdin: {
        contents: entry,
        resolveDir: APP_DIR,
        sourcefile: "cloud-pair-evidence-entry.ts",
        loader: "ts",
      },
      bundle: true,
      write: false,
      format: "iife",
      globalName: "__cloudPairEvidenceModules",
      platform: "browser",
      jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"' },
      loader: {
        ".css": "empty",
        ".svg": "dataurl",
        ".png": "dataurl",
        ".woff": "empty",
        ".woff2": "empty",
      },
      plugins: [stubElizaCore, stubNodeBuiltins],
      absWorkingDir: REPO_ROOT,
      logLevel: "silent",
    });
    const [output] = result.outputFiles;
    if (!output) throw new Error("evidence module bundle produced no output");
    return output.text;
  })();
  return evidenceBundlePromise;
}

/**
 * Serve a bare same-origin HTML shell instead of the mounted app: the app
 * boots a view realm whose surface-realm guard (correctly) rejects raw
 * localStorage writes to the reserved `eliza:` namespace from page context,
 * so the harness must run BEFORE any view mounts. `stylesheetHrefs` links the
 * smoke stack's real built app stylesheets so rendered surfaces are the
 * styled production output, not an unstyled DOM skeleton.
 */
async function serveBareShell(
  page: Page,
  stylesheetHrefs: readonly string[] = [],
): Promise<void> {
  const links = stylesheetHrefs
    .map((href) => `<link rel="stylesheet" href="${href}">`)
    .join("");
  await page.route("**/*", async (route) => {
    const url = route.request().url();
    if (url.endsWith("/") || url.endsWith("/index.html")) {
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: `<!doctype html><html><head><meta charset="utf-8">${links}</head><body><div id='root'></div></body></html>`,
      });
      return;
    }
    await route.fallback();
  });
}

/** The built app's stylesheet hrefs, read from the served index.html. */
async function builtStylesheetHrefs(baseURL: string): Promise<string[]> {
  const response = await fetch(baseURL);
  if (!response.ok) {
    throw new Error(`smoke stack index fetch failed: ${response.status}`);
  }
  const html = await response.text();
  return [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g)]
    .map((match) => match[1])
    .filter((href): href is string => typeof href === "string");
}

const AGENT_A = "agent-aaaa";
const AGENT_B = "agent-bbbb";
const TOKEN_A = "pair-token-agent-a";
const TOKEN_B = "pair-token-agent-b";
const LEGACY_TOKEN = "pair-token-legacy";
const LEGACY_KEY = "eliza:cloud-pair:api-token";
const ACTIVE_SERVER_KEY = "elizaos:active-server";
const AGENT_A_KEY = `eliza:cloud-pair:api-token:${AGENT_A}`;
const AGENT_B_KEY = `eliza:cloud-pair:api-token:${AGENT_B}`;

// The in-page runner: reads the REAL modules from the injected evidence
// bundle, extracts + executes the REAL boot adopter from the main.tsx source
// (passed in from the node side, read from the repo), and runs the full
// lifecycle. Returns structured phases for assertion + evidence save.
const IN_PAGE_RUNNER = async (mainSource: string) => {
  const agentA = "agent-aaaa";
  const agentB = "agent-bbbb";
  const tokenA = "pair-token-agent-a";
  const tokenB = "pair-token-agent-b";
  const legacyToken = "pair-token-legacy";
  const legacyKey = "eliza:cloud-pair:api-token";
  const activeServerKey = "elizaos:active-server";

  const snap = () => {
    const read = (store: Storage) => {
      const out: Record<string, string> = {};
      for (let i = 0; i < store.length; i += 1) {
        const k = store.key(i);
        if (k !== null) out[k] = store.getItem(k) ?? "";
      }
      return out;
    };
    return {
      localStorage: read(localStorage),
      sessionStorage: read(sessionStorage),
    };
  };

  const phases: Array<{
    phase: string;
    detail: string;
    storage: ReturnType<typeof snap>;
    adopted: string[];
  }> = [];
  const errors: string[] = [];
  const adopted: string[] = [];

  try {
    // The REAL production modules, bundled from repo source and injected by
    // the node side before this runner executes.
    const modules = (
      window as unknown as {
        __cloudPairEvidenceModules?: {
          relay: typeof import("../../../ui/src/components/auth/CloudPairRelay");
          tokenState: typeof import("../../../ui/src/state/cloud-pair-token");
          persistence: typeof import("../../../ui/src/state/persistence");
          agentRecovery: typeof import("../../../ui/src/state/agent-session-recovery");
          agentProfiles: typeof import("../../../ui/src/state/agent-profiles");
          cloudAgentBase: typeof import("../../../ui/src/utils/cloud-agent-base");
          realm: typeof import("../../../ui/src/surface-realm-channel");
        };
      }
    ).__cloudPairEvidenceModules;
    if (!modules) throw new Error("evidence module bundle not injected");
    const {
      relay,
      tokenState,
      persistence,
      agentRecovery,
      agentProfiles,
      cloudAgentBase,
      realm,
    } = modules;

    // Extract applyCloudPairSessionToken from the REAL main.tsx source (same
    // extraction as the reviewed unit test).
    const fnStart = mainSource.indexOf("function applyCloudPairSessionToken()");
    const fnEnd = mainSource.indexOf(
      "function shouldEnableElectrobunMacWindowDrag()",
      fnStart,
    );
    if (fnStart < 0 || fnEnd <= fnStart) {
      throw new Error("boot adopter source not found in main.tsx");
    }
    const fnBody = mainSource
      .slice(fnStart, fnEnd)
      .replace(
        "function applyCloudPairSessionToken(): void",
        "return function()",
      )
      .replace("function applyCloudPairSessionToken()", "return function()");
    // Evidence harness executes the repo's own main.tsx source in a disposable
    // browser page (no secrets). The Function constructor is required to
    // construct the boot adopter from the extracted source text at runtime.
    const makeBootAdopter = new Function(
      "client",
      "getBootConfig",
      "isEmbedPath",
      "isDedicatedCloudAgentBase",
      "dedicatedCloudAgentIdFromBase",
      "cloudPairTokenKeyForAgent",
      "loadPersistedActiveServer",
      "resolveDedicatedAgentId",
      "createPersistedActiveServer",
      "savePersistedActiveServer",
      "upsertAndActivateAgentProfile",
      "shellLocalStorage",
      "CLOUD_PAIR_SESSION_TOKEN_KEY",
      `"use strict";\n${fnBody}`,
    ) as (
      client: { setToken: (t: string) => void },
      getBootConfig: () => Record<string, unknown>,
      isEmbedPath: (p: string) => boolean,
      isDedicatedCloudAgentBase: (v: string | null | undefined) => boolean,
      dedicatedCloudAgentIdFromBase: (
        v: string | null | undefined,
      ) => string | null,
      cloudPairTokenKeyForAgent: (id: string) => string,
      loadPersistedActiveServer: () => unknown,
      resolveDedicatedAgentId: (s: unknown) => string | null,
      createPersistedActiveServer: (args: Record<string, unknown>) => unknown,
      savePersistedActiveServer: (s: unknown) => void,
      upsertAndActivateAgentProfile: (p: Record<string, unknown>) => void,
      shellLocalStorage: Storage,
      legacyKey: string,
    ) => () => void;

    const client = { setToken: (t: string) => adopted.push(t) };

    // Phase 1 — pair: write the REAL pair state through the REAL persist
    // channel (both storages), plus a cross-agent key and a legacy global key.
    // The legacy key is a reserved shell key — write it through the real
    // shellLocalStorage facade (production code path), not raw localStorage.
    relay.persistCloudPairApiToken(tokenA, agentA);
    relay.persistCloudPairApiToken(tokenB, agentB);
    realm.shellLocalStorage.setItem(legacyKey, legacyToken);
    realm.shellLocalStorage.setItem(
      activeServerKey,
      JSON.stringify({
        id: `cloud:${agentA}`,
        kind: "cloud",
        label: "Eliza Cloud",
        apiBase: `https://${agentA}.elizacloud.ai`,
        accessToken: tokenA,
      }),
    );
    phases.push({
      phase: "1-pair",
      detail: "persisted per-agent keys A+B, legacy key, active server for A",
      storage: snap(),
      adopted: [...adopted],
    });

    // Phase 2 — relaunch: run the REAL boot adopter (extracted source, real
    // collaborators). Gate 1 resolves the dedicated base from boot config; the
    // dedicated origin mirrors it for Gate 3 (owner-bound read).
    const bootAdopter = makeBootAdopter(
      client,
      () => ({ apiBase: `https://${agentA}.elizacloud.ai` }),
      () => false,
      cloudAgentBase.isDedicatedCloudAgentBase,
      cloudAgentBase.dedicatedCloudAgentIdFromBase,
      relay.cloudPairTokenKeyForAgent,
      persistence.loadPersistedActiveServer,
      agentRecovery.resolveDedicatedAgentId,
      persistence.createPersistedActiveServer,
      persistence.savePersistedActiveServer,
      agentProfiles.upsertAndActivateAgentProfile,
      realm.shellLocalStorage,
      "eliza:cloud-pair:api-token",
    );
    bootAdopter();
    phases.push({
      phase: "2-relaunch-adoption",
      detail: `boot adopter ran; adopted tokens: ${JSON.stringify(adopted)}`,
      storage: snap(),
      adopted: [...adopted],
    });

    // Phase 3 — agent delete/disconnect: clear through the REAL production
    // scoped clear. Agent A's key goes; agent B's key AND the legacy global
    // key (unknown owner on a pre-migration install) must survive.
    tokenState.clearCloudPairApiToken(agentA);
    phases.push({
      phase: "3-after-clear",
      detail: "clearCloudPairApiToken(agentA) executed",
      storage: snap(),
      adopted: [...adopted],
    });

    // Phase 4 — global disconnect/sign-out: the no-agentId clear purges every
    // scoped key plus the legacy global key from BOTH storages.
    tokenState.clearCloudPairApiToken();
    phases.push({
      phase: "4-after-global-clear",
      detail: "clearCloudPairApiToken() (global) executed",
      storage: snap(),
      adopted: [...adopted],
    });
  } catch (e) {
    errors.push(`harness error: ${String(e)}`);
  }

  return { phases, errors };
};

test.describe("cloud-pair credential lifecycle — real browser evidence", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("pair → relaunch → clear → relaunch → offline negative", async ({
    page,
    baseURL,
  }) => {
    expect(baseURL, "baseURL required").toBeTruthy();
    await page.addInitScript(() => {
      // Bare shell has no app boot → no bundler process polyfill. Provide the
      // minimal browser-safe shim some @elizaos/ui module chains read.
      (window as unknown as Record<string, unknown>).process = {
        env: {},
        browser: true,
        cwd: () => "/",
        platform: "linux",
      };
    });

    await serveBareShell(page);

    // Load the bare shell so the page origin is the smoke stack server.
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(500);

    // Inject the REAL production modules, then run the lifecycle harness.
    await page.addScriptTag({ content: await evidenceModulesBundle() });
    // The in-page extraction executes the adopter with `new Function`, so hand
    // it the type-stripped (but otherwise untouched) main.tsx source — the
    // same shape the retired dev-server module graph used to serve.
    const mainSource = (
      await transform(
        await readFile(join(APP_DIR, "src", "main.tsx"), "utf8"),
        { loader: "tsx", jsx: "automatic" },
      )
    ).code;
    const result = (await page.evaluate(
      async ({ runnerSource, mainSource }) => {
        // runnerSource is the stringified function above; execute it in page.
        // eslint-disable-next-line @typescript-eslint/no-implied-eval
        const runner = new Function(`return (${runnerSource})`)() as (
          mainSource: string,
        ) => Promise<unknown>;
        return runner(mainSource);
      },
      // Serialize the runner function body (avoid TS const capture issues).
      { runnerSource: IN_PAGE_RUNNER.toString(), mainSource },
    )) as Awaited<ReturnType<typeof IN_PAGE_RUNNER>>;

    expect(
      result.errors,
      `harness errors: ${result.errors.join("; ")}`,
    ).toEqual([]);
    expect(result.phases.length).toBe(4);

    const [phase1, phase2, phase3, phase4] = result.phases;

    // Save evidence artifacts.
    await mkdir(OUT_DIR, { recursive: true });
    for (const phase of result.phases) {
      await writeFile(
        join(OUT_DIR, `storage-dump-${phase.phase}.json`),
        JSON.stringify(phase.storage, null, 2),
      );
      await page.screenshot({
        path: join(OUT_DIR, `${phase.phase}.png`),
        fullPage: true,
      });
    }

    // Phase 1 assertions — pair state at rest.
    expect(phase1.storage.localStorage[AGENT_A_KEY]).toBe(TOKEN_A);
    expect(phase1.storage.sessionStorage[AGENT_A_KEY]).toBe(TOKEN_A);
    expect(phase1.storage.localStorage[AGENT_B_KEY]).toBe(TOKEN_B);
    expect(phase1.storage.localStorage[LEGACY_KEY]).toBe(LEGACY_TOKEN);

    // Phase 2 assertions — relaunch adoption.
    // Agent A token adopted (boot adopter found it under the owner-bound key).
    expect(phase2.adopted).toContain(TOKEN_A);
    // Agent B token NEVER adopted (cross-agent isolation — boot targets agent A).
    expect(phase2.adopted).not.toContain(TOKEN_B);
    // Legacy token NOT adopted (no ownership proof: active server carries token A).
    expect(phase2.adopted).not.toContain(LEGACY_TOKEN);
    // Adoption mirrored into the active-server record.
    const activeServer = JSON.parse(
      phase2.storage.localStorage[ACTIVE_SERVER_KEY] ?? "null",
    ) as { accessToken?: string } | null;
    expect(activeServer?.accessToken).toBe(TOKEN_A);

    // Phase 3 assertions — scoped clear purges agent A from BOTH storages
    // while the legacy global key (unknown owner) and agent B survive.
    expect(phase3.storage.localStorage[AGENT_A_KEY]).toBeUndefined();
    expect(phase3.storage.sessionStorage[AGENT_A_KEY]).toBeUndefined();
    expect(phase3.storage.localStorage[LEGACY_KEY]).toBe(LEGACY_TOKEN);
    // Cross-agent key untouched by agent A's clear.
    expect(phase3.storage.localStorage[AGENT_B_KEY]).toBe(TOKEN_B);
    expect(phase3.storage.sessionStorage[AGENT_B_KEY]).toBe(TOKEN_B);

    // Phase 4 assertions — global clear purges every scoped key + legacy key.
    expect(phase4.storage.localStorage[AGENT_B_KEY]).toBeUndefined();
    expect(phase4.storage.sessionStorage[AGENT_B_KEY]).toBeUndefined();
    expect(phase4.storage.localStorage[LEGACY_KEY]).toBeUndefined();
    expect(phase4.storage.sessionStorage[LEGACY_KEY]).toBeUndefined();

    // Manifest.
    await writeFile(
      join(OUT_DIR, "MANIFEST.md"),
      [
        "# Cloud-pair credential lifecycle evidence (#17579)",
        "",
        `Head: ${process.env.GITHUB_SHA ?? "local"} — baseURL ${baseURL}`,
        "",
        "Method: REAL production modules (CloudPairRelay persist, cloud-pair-token clear,",
        "persistence, agent-profiles, agent-session-recovery) bundled from repo source +",
        "REAL boot-adopter source extracted from main.tsx, executed in headless Chromium",
        "with real localStorage/sessionStorage on the smoke stack's origin. No jsdom, no mocks.",
        "",
        "| Phase | Storage dump | Screenshot |",
        "|---|---|---|",
        "| 1. pair (persist A+B + legacy + active server) | storage-dump-1-pair.json | 1-pair.png |",
        "| 2. relaunch (REAL boot adopter) | storage-dump-2-relaunch-adoption.json | 2-relaunch-adoption.png |",
        "| 3. after REAL clearCloudPairApiToken(agentA) | storage-dump-3-after-clear.json | 3-after-clear.png |",
        "| 4. after REAL global clearCloudPairApiToken() | storage-dump-4-after-global-clear.json | 4-after-global-clear.png |",
        "",
        "Assertions (all green in this run):",
        "- Phase 1: per-agent key A in localStorage AND sessionStorage; legacy key present",
        "- Phase 2: boot adopter adopts ONLY agent A's token; agent B token never adopted;",
        "  legacy token not adopted without ownership proof; active-server mirrors token A",
        "- Phase 3: scoped clear purges agent A key from BOTH storages; agent B key AND the",
        "  legacy global key (unknown owner) untouched",
        "- Phase 4: global clear purges every scoped key plus the legacy key from BOTH storages",
      ].join("\n"),
    );

    console.log(`Evidence written to ${OUT_DIR}`);
  });

  test("session-only pairing fallback renders a distinct non-success state", async ({
    page,
    baseURL,
  }) => {
    // When the pairing exchange succeeds but no owning agent can be resolved
    // (non-dedicated origin, no dedicated boot apiBase — exactly this bare
    // localhost shell), the REAL CloudPairRelay must install the bearer for
    // the live session only and render the visibly distinct session-only
    // state instead of silently redirecting as a success.
    expect(baseURL, "baseURL required").toBeTruthy();
    await page.addInitScript(() => {
      (window as unknown as Record<string, unknown>).process = {
        env: {},
        browser: true,
        cwd: () => "/",
        platform: "linux",
      };
    });
    // Link the real built app stylesheets so the captured surface is the
    // styled production render, not an unstyled DOM skeleton.
    await serveBareShell(page, await builtStylesheetHrefs(baseURL as string));
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.addScriptTag({ content: await evidenceModulesBundle() });

    await page.evaluate(async () => {
      const modules = (
        window as unknown as {
          __cloudPairEvidenceModules?: {
            relay: typeof import("../../../ui/src/components/auth/CloudPairRelay");
            react: typeof import("react");
            reactDomClient: typeof import("react-dom/client");
          };
        }
      ).__cloudPairEvidenceModules;
      if (!modules) throw new Error("evidence module bundle not injected");
      const { relay, react, reactDomClient: reactDom } = modules;
      const rootEl = document.getElementById("root");
      if (!rootEl) throw new Error("root missing");
      const globals = globalThis as Record<string, unknown>;
      globals.__evidencePaired = false;
      const root = reactDom.createRoot(rootEl);
      root.render(
        react.createElement(relay.CloudPairRelay, {
          token: "pair-token",
          // Delayed resolve keeps the unchanged pairing resting state visible
          // long enough to capture it as the before-state.
          exchangeFn: () =>
            new Promise((resolvePair) =>
              setTimeout(() => resolvePair("agent-key"), 1500),
            ),
          onPaired: () => {
            globals.__evidencePaired = true;
          },
        }),
      );
    });

    await mkdir(OUT_DIR, { recursive: true });

    // Before: the pairing resting state (unchanged by this PR).
    await expect(page.getByText("Signing in to your agent")).toBeVisible();
    await page.screenshot({
      path: join(OUT_DIR, "0-pairing-before.png"),
      fullPage: true,
    });

    // After: the distinct session-only state.
    await expect(
      page.getByText("Signed in for this session only"),
    ).toBeVisible();
    await page.screenshot({
      path: join(OUT_DIR, "5-session-only-fallback.png"),
      fullPage: true,
    });

    const state = await page.evaluate(() => {
      const globals = globalThis as Record<string, unknown>;
      const bootConfig = globals.__ELIZA_APP_BOOT_CONFIG__ as
        | { apiToken?: string }
        | undefined;
      return {
        pairedBeforeContinue: globals.__evidencePaired === true,
        sessionBearerInstalled: bootConfig?.apiToken === "agent-key",
        localStorageLength: window.localStorage.length,
        sessionStorageLength: window.sessionStorage.length,
      };
    });

    // Bearer live in-memory, nothing persisted, no silent auto-redirect.
    expect(state.pairedBeforeContinue).toBe(false);
    expect(state.sessionBearerInstalled).toBe(true);
    expect(state.localStorageLength).toBe(0);
    expect(state.sessionStorageLength).toBe(0);

    // The explicit continue hands off to onPaired.
    await page.getByRole("button", { name: "Continue to your agent" }).click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (globalThis as Record<string, unknown>).__evidencePaired === true,
        ),
      )
      .toBe(true);
  });
});
