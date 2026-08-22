/** Starts, registers, and disposes the desktop browser enrollment broker. */

import { Session } from "electrobun/bun";
import { resolveMainWindowPartition } from "../main-window-session";
import { resolveStartupBundlePath } from "../startup-trace";
import {
  CSRF_COOKIE_NAME,
  type DesktopSession,
  loadOrCreateDesktopSession,
  SESSION_COOKIE_NAME,
} from "./auth-bridge";
import { loadOrCreateBrowserBridgeBrokerSecret } from "./browser-bridge-broker-secret";
import {
  type BrowserBridgeBrokerServerHandle,
  startBrowserBridgeBrokerServer,
} from "./browser-bridge-broker-server";
import {
  createMacAppGroupBrokerTransportDescriptor,
  defaultBrokerTransportDescriptor,
} from "./browser-bridge-broker-transport";
import { BrowserBridgeEnrollmentBroker } from "./browser-bridge-enrollment-broker";
import {
  loadOrCreateMacBrowserBridgeSharedSecret,
  resolveMacBrowserBridgeAppGroupContainer,
} from "./browser-bridge-mac-shared-secret";
import { verifyRunningBrowserBridgeMacAuthority } from "./browser-bridge-mac-signing";
import { browserBridgeCallerAllowlistFromEnv } from "./browser-bridge-native-host-entry";
import {
  type BrowserBridgeRegistrationPlan,
  defaultBrowserBridgeRegistrationPlan,
  installBrowserBridgeRegistration,
  resolveBrowserBridgeNativeHostExecutable,
} from "./browser-bridge-registration";

let stopActiveBroker: (() => Promise<void>) | null = null;
let activeApiBase: string | null = null;

async function closeBrokerServers(
  servers: readonly BrowserBridgeBrokerServerHandle[],
): Promise<void> {
  const results = await Promise.allSettled(
    [...servers].reverse().map((server) => server.close()),
  );
  const failures = results
    .filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    )
    .map((result) => result.reason);
  if (failures.length > 0) {
    throw new AggregateError(failures, "browser bridge broker shutdown failed");
  }
}

export function isBrowserBridgeLoopbackApiBase(apiBase: string): boolean {
  try {
    const url = new URL(apiBase);
    return (
      url.protocol === "http:" &&
      (url.hostname === "127.0.0.1" ||
        url.hostname === "localhost" ||
        url.hostname === "::1") &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    // error-policy:J3 external runtime input must be an exact loopback origin.
    return false;
  }
}

interface DesktopCookieAuthority {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expirationDate?: number;
}

export function desktopOwnerSessionFromCookies(
  cookies: readonly DesktopCookieAuthority[],
  apiBase: string,
  nowMs = Date.now(),
): DesktopSession | null {
  const hostname = new URL(apiBase).hostname.toLowerCase();
  const eligible = cookies.filter(
    (cookie) =>
      typeof cookie.domain === "string" &&
      cookie.domain.replace(/^\./, "").toLowerCase() === hostname &&
      cookie.path === "/" &&
      (!cookie.expirationDate || cookie.expirationDate * 1_000 > nowMs),
  );
  const sessionId = eligible.find(
    (cookie) => cookie.name === SESSION_COOKIE_NAME,
  )?.value;
  const csrfToken = eligible.find(
    (cookie) => cookie.name === CSRF_COOKIE_NAME,
  )?.value;
  if (!sessionId || !csrfToken) return null;
  const expirations = eligible
    .map((cookie) => cookie.expirationDate)
    .filter((value): value is number => typeof value === "number");
  const expiresAt =
    expirations.length > 0
      ? Math.min(...expirations) * 1_000
      : nowMs + 5 * 60_000;
  return { sessionId, csrfToken, expiresAt };
}

async function resolveDesktopOwnerSession(
  apiBase: string,
  env: NodeJS.ProcessEnv,
): Promise<DesktopSession | null> {
  const persisted = await loadOrCreateDesktopSession({ apiBase, env });
  if (persisted) return persisted;
  const partition = resolveMainWindowPartition(env);
  const session = partition
    ? Session.fromPartition(partition)
    : Session.defaultSession;
  return desktopOwnerSessionFromCookies(session.cookies.get(), apiBase);
}

export async function startBrowserBridgeDesktopLifecycle(options: {
  apiBase: string;
  env?: NodeJS.ProcessEnv;
  executablePath?: string;
  registrationPlan?: BrowserBridgeRegistrationPlan;
  installRegistration?: (plan: BrowserBridgeRegistrationPlan) => void;
  macSafariAppGroupContainerPath?: string;
  macSafariAppBundlePath?: string;
  verifyMacSafariAuthority?: (
    moduleDir: string,
    appBundlePath: string | null,
  ) => string | null;
  loadMacSafariSecret?: (containerPath: string) => Buffer;
}): Promise<boolean> {
  if (!isBrowserBridgeLoopbackApiBase(options.apiBase)) {
    throw new Error("browser bridge desktop lifecycle requires a loopback API");
  }
  if (stopActiveBroker && activeApiBase === options.apiBase) return true;
  if (stopActiveBroker) await stopBrowserBridgeDesktopLifecycle();
  const env = options.env ?? process.env;
  if (
    /^(?:1|true|yes|on)$/i.test(env.ELIZA_BROWSER_BRIDGE_DISABLED?.trim() ?? "")
  ) {
    return false;
  }
  const allowlist = browserBridgeCallerAllowlistFromEnv(env);
  if (
    allowlist.chromeExtensionIds.length === 0 &&
    allowlist.firefoxExtensionIds.length === 0 &&
    allowlist.safariExtensionIds.length === 0
  ) {
    return false;
  }
  const secret = loadOrCreateBrowserBridgeBrokerSecret(env);
  const broker = new BrowserBridgeEnrollmentBroker({
    apiBase: options.apiBase,
    ownerSession: async () => resolveDesktopOwnerSession(options.apiBase, env),
    brokerSecret: secret,
    callerAllowlist: allowlist,
  });
  const servers: BrowserBridgeBrokerServerHandle[] = [];
  const server = await startBrowserBridgeBrokerServer({
    descriptor: defaultBrokerTransportDescriptor({ env, brokerSecret: secret }),
    broker,
  });
  servers.push(server);
  try {
    if (
      process.platform === "darwin" &&
      allowlist.safariExtensionIds.length > 0
    ) {
      const provisionedAppGroup = (
        options.verifyMacSafariAuthority ??
        verifyRunningBrowserBridgeMacAuthority
      )(
        import.meta.dir,
        options.macSafariAppBundlePath ??
          resolveStartupBundlePath(options.executablePath ?? process.execPath),
      );
      // Safari sharing stays disabled until packaging proves the exact App Group profile.
      if (provisionedAppGroup) {
        const appGroupContainer =
          options.macSafariAppGroupContainerPath ??
          resolveMacBrowserBridgeAppGroupContainer();
        const safariBroker = new BrowserBridgeEnrollmentBroker({
          apiBase: options.apiBase,
          ownerSession: async () =>
            resolveDesktopOwnerSession(options.apiBase, env),
          brokerSecret: (
            options.loadMacSafariSecret ??
            loadOrCreateMacBrowserBridgeSharedSecret
          )(appGroupContainer),
          callerAllowlist: allowlist,
        });
        servers.push(
          await startBrowserBridgeBrokerServer({
            descriptor:
              createMacAppGroupBrokerTransportDescriptor(appGroupContainer),
            broker: safariBroker,
          }),
        );
      }
    }
    (options.installRegistration ?? installBrowserBridgeRegistration)(
      options.registrationPlan ??
        defaultBrowserBridgeRegistrationPlan({
          executablePath:
            options.executablePath ??
            resolveBrowserBridgeNativeHostExecutable(import.meta.dir),
          chromeExtensionIds: allowlist.chromeExtensionIds,
          firefoxExtensionIds: allowlist.firefoxExtensionIds,
        }),
    );
  } catch (error) {
    // error-policy:J2 every acquired listener is rolled back before preserving startup failure.
    try {
      await closeBrokerServers(servers);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "browser bridge startup and rollback failed",
        { cause: error },
      );
    }
    throw error;
  }
  stopActiveBroker = async () => {
    try {
      await closeBrokerServers(servers);
    } finally {
      stopActiveBroker = null;
      activeApiBase = null;
    }
  };
  activeApiBase = options.apiBase;
  return true;
}

export async function stopBrowserBridgeDesktopLifecycle(): Promise<void> {
  await stopActiveBroker?.();
}
