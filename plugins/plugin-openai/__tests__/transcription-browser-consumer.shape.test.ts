/**
 * Consumer-level browser regression for #18702: spawns a bun helper that
 * bundles the plugin's browser entrypoint with the production Bun.build
 * settings (browser target, package.json externals) and asserts the emitted
 * graph never names the `@elizaos/core/node` subpath or a `node:` built-in,
 * that the browser (not the Node) URL-fetcher registration ships, and that
 * core's real browser entry source exports the SSRF policy helpers the
 * boundary imports. Real bundler and real core source — no mocks, no network.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const pluginRoot = path.resolve(__dirname, "..");
const helper = path.join(__dirname, "helpers", "browser-consumer-bundle.mjs");

type BundleProbe = {
  success: boolean;
  logs?: string[];
  hasCoreNodeSubpath?: boolean;
  nodeBuiltins?: string[];
  registersBrowserFetcher?: boolean;
  registersNodeFetcher?: boolean;
  coreBrowserExports?: Record<string, string>;
};

describe("browser consumer bundle of @elizaos/plugin-openai", () => {
  it("bundles the URL-transcription path without Node subpaths or built-ins", () => {
    const stdout = execFileSync("bun", [helper], {
      cwd: pluginRoot,
      encoding: "utf8",
      timeout: 120_000,
    });
    const probe = JSON.parse(stdout.trim().split("\n").pop() ?? "{}") as BundleProbe;

    expect(probe.success, `bundle failed: ${JSON.stringify(probe.logs)}`).toBe(true);

    // The defect Shaw reopened on: the browser graph following the explicit
    // node subpath into the Node artifact (node:crypto / node:os).
    expect(probe.hasCoreNodeSubpath).toBe(false);
    expect(probe.nodeBuiltins).toEqual([]);

    // The browser guarded boundary — not the Node one — is what registers.
    expect(probe.registersBrowserFetcher).toBe(true);
    expect(probe.registersNodeFetcher).toBe(false);

    // The boundary's imports must exist on core's browser entry, or a real
    // consumer fails at module evaluation despite a green plugin build.
    expect(probe.coreBrowserExports).toEqual({
      isBlockedHostname: "function",
      isPrivateIpAddress: "function",
      SsrfBlockedError: "function",
    });
  }, 150_000);
});
