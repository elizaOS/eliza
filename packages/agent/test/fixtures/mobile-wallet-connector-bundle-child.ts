/**
 * Child fixture for the mobile wallet-connector exclusion: bundles an entry that imports
 * wagmi, RainbowKit and MetaMask packages (bare and subpath) with the same plugin
 * build-mobile-bundle.ts installs, then runs the bundle in a fresh Bun process. Prints one
 * `WALLET_RESULT=<json>` line with the bundle's inputs and the observed behaviour.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mobileWalletConnectorStubPlugin } from "../../scripts/mobile-wallet-connectors.ts";

const workDir = process.argv[2];
if (!workDir) throw new Error("Expected a work directory argument.");
const stub = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../scripts/mobile-stubs/null-plugin.ts",
);
const entry = path.join(workDir, "entry.ts");
writeFileSync(
  entry,
  `import { createConfig, WagmiProvider } from "wagmi";
import { base } from "wagmi/chains";
import { injected } from "wagmi/connectors";
import { getAccount } from "@wagmi/core";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { MetaMaskSDK } from "@metamask/sdk";
import * as evm from "@metamask/connect-evm";
let failed = false;
try { createConfig({ chains: [base] }); } catch { failed = true; }
let sdkFailed = false;
try { new MetaMaskSDK({}); } catch { sdkFailed = true; }
console.log(JSON.stringify({
  loaded: true,
  failed,
  sdkFailed,
  types: [typeof WagmiProvider, typeof injected, typeof getAccount, typeof ConnectButton, typeof MetaMaskSDK, typeof evm],
}));
`,
);
const outdir = path.join(workDir, "out");
mkdirSync(outdir, { recursive: true });
const build = await Bun.build({
  entrypoints: [entry],
  outdir,
  target: "bun",
  format: "esm",
  metafile: true,
  plugins: [mobileWalletConnectorStubPlugin(stub)],
});
if (!build.success) throw new AggregateError(build.logs, "Bun.build failed");
const run = Bun.spawnSync([process.execPath, path.join(outdir, "entry.js")]);
if (run.exitCode !== 0)
  throw new Error(`bundle exited ${run.exitCode}: ${run.stderr}`);
console.log(
  `WALLET_RESULT=${JSON.stringify({
    inputs: Object.keys(build.metafile?.inputs ?? {}),
    run: JSON.parse(run.stdout.toString()),
  })}`,
);
