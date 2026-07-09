/**
 * Regression guard for the wallet sign-in connector peer dependencies.
 *
 * The EVM "sign in with a wallet" button lazy-mounts wagmi + RainbowKit on
 * click. When the user has NO injected wallet (`window.ethereum` absent — every
 * mobile browser, and any desktop without a wallet extension), RainbowKit falls
 * back to the MetaMask **SDK** connector for the QR / deeplink flow. That
 * connector does a runtime `await import("@metamask/connect-evm")`
 * (`@wagmi/connectors` metaMask.js) — a dependency wagmi *declares* but that the
 * workspace must actually install, or the dynamic import throws
 * `Could not resolve "@metamask/connect-evm"` at click-time and the wallet flow
 * dead-ends (#15600, fixed by #15608).
 *
 * Nothing else catches a drop of this dep: it is a browser-runtime lazy import,
 * so the app BUILDS and every jsdom unit test passes even when it is missing —
 * the failure only surfaces when a real no-wallet browser clicks EVM. This test
 * pins the dep in `packages/ui/package.json` so a future dependency bump that
 * drops it fails CI here instead of silently in production onboarding.
 *
 * Same family: the wallet modals' vendor stylesheets (RainbowKit and the Solana
 * wallet-adapter modal) are owned by the host CSS entry (`cloud-ui/index.css`)
 * because `steward-wallet-providers.tsx` is CSS-import-free by design. Without
 * those `@import`s the Solana modal renders invisible (unstyled, black-on-black
 * at the document tail) — also unreachable by jsdom tests, so it is pinned here.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
// packages/ui/src/cloud/public-pages/pages/login -> packages/ui
const uiPackageJsonPath = resolve(here, "../../../../../package.json");

/**
 * Connector SDKs that `@wagmi/connectors` (via RainbowKit) resolves through a
 * runtime `await import(...)` on the no-injected-wallet fallback path. Each MUST
 * be a resolvable dependency of `@elizaos/ui` or the corresponding wallet button
 * dead-ends the moment it is clicked. Keep in sync with the connectors wagmi
 * lazy-loads (grep `@wagmi/connectors` dist for `import(` — currently
 * metaMask.js -> @metamask/connect-evm).
 */
const RUNTIME_LAZY_CONNECTOR_DEPS = ["@metamask/connect-evm"] as const;

describe("wallet sign-in connector peer dependencies", () => {
  const pkg = JSON.parse(readFileSync(uiPackageJsonPath, "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const declared = { ...pkg.dependencies, ...pkg.devDependencies };

  it.each(
    RUNTIME_LAZY_CONNECTOR_DEPS,
  )("declares %s so the no-injected-wallet EVM fallback resolves at click-time (#15600)", (dep) => {
    expect(
      declared[dep],
      `${dep} must be a declared dependency of @elizaos/ui — wagmi/RainbowKit ` +
        `dynamically imports it on the no-wallet EVM path; dropping it resurrects ` +
        `the "Could not resolve ${dep}" click-time dead-end (#15600 / #15608).`,
    ).toBeTruthy();
  });

  // The wallet modal stylesheets live in the host CSS entry (see the header).
  // jsdom cannot see an unstyled portal, so pin the @imports statically.
  const WALLET_MODAL_STYLESHEETS = [
    "@rainbow-me/rainbowkit/styles.css",
    "@solana/wallet-adapter-react-ui/styles.css",
  ] as const;

  const cloudCssEntryPath = resolve(here, "../../../../cloud-ui/index.css");
  const cloudCssEntry = readFileSync(cloudCssEntryPath, "utf8");

  it.each(
    WALLET_MODAL_STYLESHEETS,
  )("cloud-ui/index.css imports %s so the wallet modals render styled (#15600)", (sheet) => {
    expect(
      cloudCssEntry.includes(`@import "${sheet}";`),
      `cloud-ui/index.css must \`@import "${sheet}"\` — steward-wallet-providers ` +
        `is CSS-import-free by design, so dropping this import leaves the wallet ` +
        `modal unstyled (the Solana modal renders invisible, #15600).`,
    ).toBe(true);
  });
});
