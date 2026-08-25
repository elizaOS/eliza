/**
 * Steward email callback readiness tests exercise only operator-supplied,
 * non-secret configuration; no request or tenant mutation leaves the process.
 */
import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import {
  parseStewardEmailCallbackConfigArgs,
  validateStewardEmailCallbackConfig,
} from "../verify-steward-email-callback-config.mjs";

// Absolute path so the spawned CLI resolves regardless of the runner's cwd
// (the cloud lane runs `bun test` from packages/cloud, not the repo root).
//
// The CLI is spawned under `bun`, never `process.execPath`: it imports the
// domain contract from TypeScript source, which `node` refuses with
// ERR_UNKNOWN_FILE_EXTENSION. Pinning the interpreter here asserts that
// requirement instead of inheriting whichever runtime happened to launch the
// test, and matches the `cloud:verify-steward-email-callback` root script.
const CLI_PATH = fileURLToPath(
  new URL("../verify-steward-email-callback-config.mjs", import.meta.url),
);

describe("Steward email callback configuration readiness", () => {
  test.each([
    [
      "production",
      "https://cloud.eliza.app",
      "https://cloud.eliza.app/auth/callback/email",
    ],
    [
      "staging",
      "https://cloud-staging.eliza.app",
      "https://cloud-staging.eliza.app/auth/callback/email",
    ],
  ])("accepts canonical %s configuration", (environment, base, expected) => {
    expect(
      validateStewardEmailCallbackConfig({
        environment,
        magicLinkBaseUrl: base,
        callbackPath: "/auth/callback/email",
      }),
    ).toEqual({ environment, callbackUrl: expected });
  });

  test.each([
    "https://staging.eliza.app",
    "https://app-staging.elizacloud.ai",
    "http://cloud-staging.eliza.app",
    "https://user:pass@cloud-staging.eliza.app",
    "https://cloud-staging.eliza.app/path",
    "https://cloud-staging.eliza.app?next=evil",
    "https://cloud-staging.eliza.app#fragment",
    "https://evil.example",
  ])("rejects stale or unsafe staging base %s", (magicLinkBaseUrl) => {
    expect(() =>
      validateStewardEmailCallbackConfig({
        environment: "staging",
        magicLinkBaseUrl,
        callbackPath: "/auth/callback/email",
      }),
    ).toThrow();
  });

  test("rejects a callback path that is not the public email callback", () => {
    expect(() =>
      validateStewardEmailCallbackConfig({
        environment: "production",
        magicLinkBaseUrl: "https://cloud.eliza.app",
        callbackPath: "//evil.example",
      }),
    ).toThrow("callback path");
  });

  test("requires each explicit CLI value", () => {
    expect(() => parseStewardEmailCallbackConfigArgs([])).toThrow(
      "--environment is required",
    );
  });

  test("rejects unknown flags", () => {
    expect(() =>
      parseStewardEmailCallbackConfigArgs([
        "--environment",
        "production",
        "--magic-link-base-url",
        "https://cloud.eliza.app",
        "--callback-path",
        "/auth/callback/email",
        "--api-key",
        "secret",
      ]),
    ).toThrow("Invalid arguments");
  });

  test("rejects duplicate flags", () => {
    expect(() =>
      parseStewardEmailCallbackConfigArgs([
        "--environment",
        "production",
        "--environment",
        "staging",
        "--magic-link-base-url",
        "https://cloud.eliza.app",
        "--callback-path",
        "/auth/callback/email",
      ]),
    ).toThrow("Invalid arguments");
  });
});

test("CLI exits non-zero for the stale staging callback host", async () => {
  const child = Bun.spawn(
    [
      "bun",
      CLI_PATH,
      "--environment",
      "staging",
      "--magic-link-base-url",
      "https://staging.eliza.app",
      "--callback-path",
      "/auth/callback/email",
    ],
    { cwd: process.cwd(), stderr: "pipe" },
  );
  expect(await child.exited).toBe(1);
  expect(await new Response(child.stderr).text()).toContain(
    "canonical staging app origin",
  );
});

test("CLI does not echo a raw positional secret", async () => {
  const child = Bun.spawn(["bun", CLI_PATH, "raw-positional-secret"], {
    cwd: process.cwd(),
    stderr: "pipe",
  });
  expect(await child.exited).toBe(1);
  const diagnostic = await new Response(child.stderr).text();
  expect(diagnostic).toContain("Invalid arguments");
  expect(diagnostic).not.toContain("raw-positional-secret");
});

test("CLI sanitizes a malformed magic-link base URL", async () => {
  const child = Bun.spawn(
    [
      "bun",
      CLI_PATH,
      "--environment",
      "staging",
      "--magic-link-base-url",
      "raw-url-secret",
      "--callback-path",
      "/auth/callback/email",
    ],
    { cwd: process.cwd(), stderr: "pipe" },
  );
  expect(await child.exited).toBe(1);
  const diagnostic = await new Response(child.stderr).text();
  expect(diagnostic).toContain("magic-link base URL is invalid");
  expect(diagnostic).not.toContain("raw-url-secret");
});
