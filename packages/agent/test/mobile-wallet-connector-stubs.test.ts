/**
 * The mobile agent bundle carries no browser wallet-connector closure (wagmi, RainbowKit,
 * MetaMask SDK). A separate Bun process bundles an entry importing them through the plugin
 * build-mobile-bundle.ts installs: no connector source is an input, importing is inert and any
 * use of a connector export fails. Desktop and web builds never install it.
 */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, it } from "vitest";
import {
  MOBILE_WALLET_CONNECTOR_FILTER,
  MOBILE_WALLET_CONNECTOR_PACKAGES,
} from "../scripts/mobile-wallet-connectors.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHILD = path.join(
  HERE,
  "fixtures",
  "mobile-wallet-connector-bundle-child.ts",
);
const directories: string[] = [];
afterAll(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

it("names the wallet-connector packages and matches only them", () => {
  expect(MOBILE_WALLET_CONNECTOR_PACKAGES).toEqual([
    "wagmi",
    "@wagmi/*",
    "@rainbow-me/*",
    "@metamask/*",
  ]);
  for (const specifier of [
    "wagmi",
    "wagmi/chains",
    "@wagmi/connectors",
    "@wagmi/core/actions",
    "@rainbow-me/rainbowkit",
    "@rainbow-me/rainbowkit/styles.css",
    "@metamask/sdk",
    "@metamask/connect-evm",
  ])
    expect(MOBILE_WALLET_CONNECTOR_FILTER.test(specifier), specifier).toBe(
      true,
    );
  for (const specifier of [
    "viem",
    "ethers",
    "wagmi-extra",
    "@elizaos/plugin-wallet",
    "@tanstack/react-query",
    "./wagmi",
  ])
    expect(MOBILE_WALLET_CONNECTOR_FILTER.test(specifier), specifier).toBe(
      false,
    );
});

it("is installed by the mobile bundle build", async () => {
  const source = await readFile(
    path.join(HERE, "..", "scripts", "build-mobile-bundle.ts"),
    "utf8",
  );
  expect(source).toMatch(
    /mobileWalletConnectorStubPlugin\(path\.join\(stubsDir, "null-plugin\.ts"\)\)/,
  );
});

it("bundles wallet-connector imports as inert, throw-on-call stubs", async () => {
  const workDir = await mkdtemp(path.join(tmpdir(), "eliza-mobile-wallet-"));
  directories.push(workDir);
  const { status, stdout, stderr } = await new Promise<{
    status: number | null;
    stdout: string;
    stderr: string;
  }>((resolve, reject) => {
    const child = spawn("bun", [CHILD, workDir], {
      cwd: path.join(HERE, ".."),
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`wallet stub bundle child timed out\n${err}`));
    }, 60_000);
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      err += chunk.toString();
    });
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ status: code, stdout: out, stderr: err });
    });
  });
  expect(status, stderr).toBe(0);
  const line = stdout
    .split("\n")
    .find((row) => row.startsWith("WALLET_RESULT="));
  expect(line, stdout).toBeDefined();
  const result = JSON.parse(line?.slice("WALLET_RESULT=".length) ?? "{}");
  expect(
    result.inputs.filter((input: string) =>
      /node_modules[\\/](?:wagmi|@wagmi|@rainbow-me|@metamask)[\\/]/.test(
        input,
      ),
    ),
  ).toEqual([]);
  // Named bindings off the CommonJS stub are absent, so nothing runs at import time and
  // any use fails loudly; the namespace import is the stub itself.
  expect(result.run).toEqual({
    loaded: true,
    failed: true,
    sdkFailed: true,
    types: [
      "undefined",
      "undefined",
      "undefined",
      "undefined",
      "undefined",
      "object",
    ],
  });
});
