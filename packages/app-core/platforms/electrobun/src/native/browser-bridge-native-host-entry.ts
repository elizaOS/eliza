/** Runs the browser native-messaging stdin/stdout loop without starting desktop UI. */

import fs from "node:fs";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { loadBrowserBridgeBrokerSecret } from "./browser-bridge-broker-secret";
import {
  defaultBrokerTransportDescriptor,
  NodeBrowserBridgeBrokerTransport,
} from "./browser-bridge-broker-transport";
import { BrowserBridgeNativeHost } from "./browser-bridge-native-host";
import {
  type BrowserBridgeCallerAllowlist,
  type BrowserBridgeNativeCaller,
  type BrowserBridgeNativeErrorCode,
  encodeNativeMessage,
  NativeMessageDecoder,
  parseNativeEnrollmentRequest,
  parseNativeHostLaunchCaller,
} from "./browser-bridge-native-protocol";

export const FIREFOX_BROWSER_BRIDGE_EXTENSION_ID = "browser-bridge@elizaos.ai";
export const SAFARI_BROWSER_BRIDGE_EXTENSION_ID =
  "ai.elizaos.browserbridge.app.Extension";
const NATIVE_HOST_MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

function splitIds(value: string | undefined): string[] {
  return [
    ...new Set(
      (value ?? "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

function withReleaseId(
  releaseId: string,
  configured: string | undefined,
): string[] {
  return [...new Set([releaseId, ...splitIds(configured)])];
}

function loadCommittedBrowserBridgeIds(moduleDir: string): {
  chromeExtensionId: string | null;
  firefoxExtensionId: string;
  safariExtensionId: string;
} {
  const candidates = [
    path.resolve(moduleDir, "..", "browser-bridge-release.json"),
    path.resolve(moduleDir, "..", "..", "build", "browser-bridge-release.json"),
    path.resolve(
      moduleDir,
      "..",
      "..",
      "..",
      "..",
      "..",
      "browser-bridge-extension",
      "identity.json",
    ),
  ];
  const identityPath = candidates.find(fs.existsSync);
  if (!identityPath) {
    return {
      chromeExtensionId: null,
      firefoxExtensionId: FIREFOX_BROWSER_BRIDGE_EXTENSION_ID,
      safariExtensionId: SAFARI_BROWSER_BRIDGE_EXTENSION_ID,
    };
  }
  const parsed = JSON.parse(fs.readFileSync(identityPath, "utf8")) as Record<
    string,
    unknown
  >;
  const chromeExtensionId = parsed.chromeExtensionId;
  const firefoxExtensionId = parsed.firefoxExtensionId;
  const safariExtensionId = parsed.safariExtensionId;
  if (
    typeof chromeExtensionId !== "string" ||
    !/^[a-p]{32}$/.test(chromeExtensionId) ||
    firefoxExtensionId !== FIREFOX_BROWSER_BRIDGE_EXTENSION_ID ||
    safariExtensionId !== SAFARI_BROWSER_BRIDGE_EXTENSION_ID
  ) {
    throw new Error("packaged browser bridge identity is invalid");
  }
  return { chromeExtensionId, firefoxExtensionId, safariExtensionId };
}

export function browserBridgeCallerAllowlistFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  moduleDir = NATIVE_HOST_MODULE_DIR,
): BrowserBridgeCallerAllowlist {
  const committed = loadCommittedBrowserBridgeIds(moduleDir);
  return {
    chromeExtensionIds: [
      ...(committed.chromeExtensionId ? [committed.chromeExtensionId] : []),
      ...splitIds(env.ELIZA_BROWSER_BRIDGE_CHROME_EXTENSION_IDS),
    ],
    firefoxExtensionIds: withReleaseId(
      FIREFOX_BROWSER_BRIDGE_EXTENSION_ID,
      env.ELIZA_BROWSER_BRIDGE_FIREFOX_EXTENSION_IDS,
    ),
    safariExtensionIds: withReleaseId(
      SAFARI_BROWSER_BRIDGE_EXTENSION_ID,
      env.ELIZA_BROWSER_BRIDGE_SAFARI_EXTENSION_IDS,
    ),
  };
}

export function resolveNativeHostInvocation(
  argv: readonly string[],
  allowlist: BrowserBridgeCallerAllowlist,
): BrowserBridgeNativeCaller | null {
  for (const argument of argv.slice(1)) {
    if (argument.startsWith("chrome-extension://")) {
      const caller = parseNativeHostLaunchCaller("chrome", argument);
      return allowlist.chromeExtensionIds.includes(caller.id) ? caller : null;
    }
    if (allowlist.firefoxExtensionIds.includes(argument)) {
      return parseNativeHostLaunchCaller("firefox", argument);
    }
  }
  return null;
}

function externalError(
  requestId: string,
  code: BrowserBridgeNativeErrorCode,
  retryable: boolean,
): Record<string, unknown> {
  return { v: 1, type: "browser_bridge.error", requestId, code, retryable };
}

export async function runBrowserBridgeNativeHostStdio(options: {
  caller: BrowserBridgeNativeCaller;
  allowlist: BrowserBridgeCallerAllowlist;
  stdin?: Readable;
  stdout?: Writable;
  env?: NodeJS.ProcessEnv;
  windowsUserSid?: string;
}): Promise<void> {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const decoder = new NativeMessageDecoder();
  let secret: Buffer | null;
  try {
    secret = loadBrowserBridgeBrokerSecret(options.env);
  } catch {
    // error-policy:J1 secret-store failures are exposed only after binding to a canonical request.
    secret = null;
  }
  const host = secret
    ? new BrowserBridgeNativeHost({
        launchedCaller: options.caller,
        allowlist: options.allowlist,
        brokerSecret: secret,
        transport: new NodeBrowserBridgeBrokerTransport(
          defaultBrokerTransportDescriptor({
            env: options.env,
            windowsUserSid: options.windowsUserSid,
            brokerSecret: secret,
          }),
        ),
      })
    : null;
  for await (const chunk of stdin) {
    const messages = decoder.push(chunk as Uint8Array);
    for (const message of messages) {
      let response: unknown;
      try {
        if (!host) {
          const request = parseNativeEnrollmentRequest(message);
          response = externalError(request.requestId, "app_not_running", true);
        } else {
          response = await host.handle(message);
        }
      } catch (error) {
        // error-policy:J1 native-host internals collapse into the canonical external boundary.
        const requestId =
          message &&
          typeof message === "object" &&
          typeof (message as Record<string, unknown>).requestId === "string"
            ? ((message as Record<string, unknown>).requestId as string)
            : null;
        if (
          !requestId ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
            requestId,
          )
        ) {
          throw error;
        }
        response = externalError(requestId, "app_not_running", true);
      }
      stdout.write(encodeNativeMessage(response));
    }
  }
  decoder.finish();
}
