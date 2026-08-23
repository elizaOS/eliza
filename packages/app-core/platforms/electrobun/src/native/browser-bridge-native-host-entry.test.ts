/**
 * Exercises the dedicated native-host process against a real Unix broker and
 * loopback pairing endpoint, including native-message stdin/stdout framing.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { loadOrCreateBrowserBridgeBrokerSecret } from "./browser-bridge-broker-secret";
import { startBrowserBridgeBrokerServer } from "./browser-bridge-broker-server";
import { createUnixBrokerTransportDescriptor } from "./browser-bridge-broker-transport";
import { BrowserBridgeEnrollmentBroker } from "./browser-bridge-enrollment-broker";
import {
  browserBridgeCallerAllowlistFromEnv,
  FIREFOX_BROWSER_BRIDGE_EXTENSION_ID,
  runBrowserBridgeNativeHostStdio,
  SAFARI_BROWSER_BRIDGE_EXTENSION_ID,
} from "./browser-bridge-native-host-entry";
import {
  encodeNativeMessage,
  NativeMessageDecoder,
} from "./browser-bridge-native-protocol";

const roots: string[] = [];

describe("browser bridge native-host executable", () => {
  afterEach(() => {
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  it("commits stable Firefox and Safari IDs while requiring exact Chrome IDs", () => {
    expect(browserBridgeCallerAllowlistFromEnv({})).toEqual({
      chromeExtensionIds: ["pmldpcoefklbdbgmggcejkfoinmjfeio"],
      firefoxExtensionIds: [FIREFOX_BROWSER_BRIDGE_EXTENSION_ID],
      safariExtensionIds: [SAFARI_BROWSER_BRIDGE_EXTENSION_ID],
    });
  });

  it("round-trips one enrollment through an actual stdio child process", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-child-"));
    roots.push(stateDir);
    const env = { ELIZA_STATE_DIR: stateDir };
    const secret = loadOrCreateBrowserBridgeBrokerSecret(env, () =>
      Buffer.alloc(32, 19),
    );
    const extensionId = "abcdefghijklmnopabcdefghijklmnop";
    const profileId = "123e4567-e89b-42d3-a456-426614174001";
    const api = http.createServer((request, response) => {
      if (
        request.method !== "POST" ||
        request.url !== "/api/browser-bridge/companions/pair"
      ) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(201, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          companion: {
            id: "companion-child",
            browser: "chrome",
            profileId,
            profileLabel: "Personal",
            label: "Chrome Personal",
          },
          pairingToken: "pairing-child",
          pairingTokenExpiresAt: null,
        }),
      );
    });
    await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
    const address = api.address();
    if (!address || typeof address === "string") {
      throw new Error("loopback test API address is unavailable");
    }
    const broker = new BrowserBridgeEnrollmentBroker({
      apiBase: `http://127.0.0.1:${address.port}`,
      ownerSession: async () => ({
        sessionId: "owner-session",
        csrfToken: "owner-csrf",
        expiresAt: Date.now() + 60_000,
      }),
      brokerSecret: secret,
      callerAllowlist: {
        chromeExtensionIds: [extensionId],
        firefoxExtensionIds: [FIREFOX_BROWSER_BRIDGE_EXTENSION_ID],
        safariExtensionIds: [SAFARI_BROWSER_BRIDGE_EXTENSION_ID],
      },
    });
    const server = await startBrowserBridgeBrokerServer({
      descriptor: createUnixBrokerTransportDescriptor(env),
      broker,
    });
    try {
      const bunExecutable = path.join(
        process.env.BUN_INSTALL ?? path.join(os.homedir(), ".bun"),
        "bin",
        "bun",
      );
      const child = spawn(
        bunExecutable,
        [
          path.join(import.meta.dirname, "browser-bridge-native-host-main.ts"),
          `chrome-extension://${extensionId}/`,
        ],
        {
          env: {
            ...process.env,
            ...env,
            ELIZA_BROWSER_BRIDGE_CHROME_EXTENSION_IDS: extensionId,
          },
        },
      );
      child.stdin.write(
        encodeNativeMessage({
          v: 1,
          type: "browser_bridge.enroll",
          requestId: "123e4567-e89b-42d3-a456-426614174000",
          nonce: Buffer.alloc(32, 3).toString("base64url"),
          browser: "chrome",
          extensionId,
          extensionVersion: "1.2.3",
          profileId,
        }),
      );
      child.stdin.end();
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      child.stdout.on("data", (chunk) => stdoutChunks.push(Buffer.from(chunk)));
      child.stderr.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));
      const exitCode = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", resolve);
      });
      const stdout = Buffer.concat(stdoutChunks);
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      expect(exitCode, stderr).toBe(0);
      expect(stderr).toBe("");
      const decoder = new NativeMessageDecoder();
      const responses = decoder.push(stdout);
      decoder.finish();
      expect(responses).toEqual([
        expect.objectContaining({
          type: "browser_bridge.enroll_result",
          config: expect.objectContaining({ companionId: "companion-child" }),
        }),
      ]);
    } finally {
      await server.close();
      await new Promise<void>((resolve, reject) =>
        api.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("reads the bounded request before reporting an unavailable desktop app", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-missing-"));
    roots.push(stateDir);
    const extensionId = "pmldpcoefklbdbgmggcejkfoinmjfeio";
    const requestId = "123e4567-e89b-42d3-a456-426614174000";
    const stdout = new PassThrough();
    const chunks: Buffer[] = [];
    stdout.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    await runBrowserBridgeNativeHostStdio({
      caller: { browser: "chrome", id: extensionId },
      allowlist: browserBridgeCallerAllowlistFromEnv({}),
      env: { ELIZA_STATE_DIR: stateDir },
      stdin: Readable.from([
        encodeNativeMessage({
          v: 1,
          type: "browser_bridge.enroll",
          requestId,
          nonce: Buffer.alloc(32, 3).toString("base64url"),
          browser: "chrome",
          extensionId,
          extensionVersion: "1.2.3",
          profileId: "123e4567-e89b-42d3-a456-426614174001",
        }),
      ]),
      stdout,
    });
    const decoder = new NativeMessageDecoder();
    const responses = decoder.push(Buffer.concat(chunks));
    decoder.finish();
    expect(responses).toEqual([
      {
        v: 1,
        type: "browser_bridge.error",
        requestId,
        code: "app_not_running",
        retryable: true,
      },
    ]);
    expect(JSON.stringify(responses)).not.toContain("nonce");
  });

  it("maps unsupported requests to the canonical non-retryable error", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-version-"));
    roots.push(stateDir);
    const extensionId = "pmldpcoefklbdbgmggcejkfoinmjfeio";
    const requestId = "123e4567-e89b-42d3-a456-426614174000";
    const stdout = new PassThrough();
    const chunks: Buffer[] = [];
    stdout.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    await runBrowserBridgeNativeHostStdio({
      caller: { browser: "chrome", id: extensionId },
      allowlist: browserBridgeCallerAllowlistFromEnv({}),
      env: { ELIZA_STATE_DIR: stateDir },
      stdin: Readable.from([
        encodeNativeMessage({
          v: 2,
          type: "browser_bridge.enroll",
          requestId,
          nonce: Buffer.alloc(32, 3).toString("base64url"),
          browser: "chrome",
          extensionId,
          extensionVersion: "1.2.3",
          profileId: "123e4567-e89b-42d3-a456-426614174001",
        }),
      ]),
      stdout,
    });
    const decoder = new NativeMessageDecoder();
    expect(decoder.push(Buffer.concat(chunks))).toEqual([
      {
        v: 1,
        type: "browser_bridge.error",
        requestId,
        code: "unsupported_version",
        retryable: false,
      },
    ]);
    decoder.finish();
  });

  it("maps an unavailable authenticated broker to broker_unavailable", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-broker-down-"));
    roots.push(stateDir);
    const env = { ELIZA_STATE_DIR: stateDir };
    loadOrCreateBrowserBridgeBrokerSecret(env, () => Buffer.alloc(32, 21));
    const extensionId = "pmldpcoefklbdbgmggcejkfoinmjfeio";
    const requestId = "123e4567-e89b-42d3-a456-426614174000";
    const stdout = new PassThrough();
    const chunks: Buffer[] = [];
    stdout.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    await runBrowserBridgeNativeHostStdio({
      caller: { browser: "chrome", id: extensionId },
      allowlist: browserBridgeCallerAllowlistFromEnv({}),
      env,
      stdin: Readable.from([
        encodeNativeMessage({
          v: 1,
          type: "browser_bridge.enroll",
          requestId,
          nonce: Buffer.alloc(32, 3).toString("base64url"),
          browser: "chrome",
          extensionId,
          extensionVersion: "1.2.3",
          profileId: "123e4567-e89b-42d3-a456-426614174001",
        }),
      ]),
      stdout,
    });
    const decoder = new NativeMessageDecoder();
    expect(decoder.push(Buffer.concat(chunks))).toEqual([
      {
        v: 1,
        type: "browser_bridge.error",
        requestId,
        code: "broker_unavailable",
        retryable: true,
      },
    ]);
    decoder.finish();
  });
});
