/**
 * Detects the runtime host kind (Cloudflare Worker, Capacitor background/
 * foreground, browser, node) from an environment probe, so callers can gate
 * behavior on what the current host actually supports.
 */
export type HostCapabilityKind =
  | "cloudflare-worker"
  | "capacitor-background-runner"
  | "capacitor-foreground-only"
  | "browser"
  | "node";

export interface HostCapabilityProbe {
  /** User agent string, when the host exposes one. */
  userAgent?: string;
  /** Whether a browser-style window global is present. */
  hasWindow?: boolean;
  /** Whether a Node/Bun-style process global is present. */
  hasProcess?: boolean;
  /** Capacitor global, when running inside a native shell. */
  capacitor?: unknown;
}

export interface HostCapabilities {
  /** Stable host classification used by tests and callers that need branching. */
  kind: HostCapabilityKind;
  /** Read/write filesystem via node:fs or equivalent. */
  fs: boolean;
  /** Can receive inbound HTTP from the public internet. */
  inbound: boolean;
  /** Host process stays alive across schedule firings. */
  longRunning: boolean;
  /** Spawns child processes via node:child_process. */
  childProcess: boolean;
  /** Raw TCP/UDP sockets via node:net, not just fetch. */
  net: boolean;
  /** True when running inside a Capacitor iOS/Android shell. */
  isMobile: boolean;
  /** True for a pure browser tab with no Capacitor or Node/Bun process. */
  isBrowser: boolean;
  /** Human-readable host label for UI banners and engine errors. */
  label: string;
}

interface NavigatorLike {
  userAgent?: string;
}

declare const navigator: NavigatorLike | undefined;

function readDefaultHostCapabilityProbe(): HostCapabilityProbe {
  return {
    userAgent:
      typeof navigator !== "undefined" &&
      typeof navigator?.userAgent === "string"
        ? navigator.userAgent
        : undefined,
    hasWindow: typeof window !== "undefined",
    hasProcess: typeof process !== "undefined",
    capacitor: Reflect.get(globalThis, "Capacitor"),
  };
}

function hasCapacitorBackgroundRunner(capacitor: unknown): boolean {
  if (!capacitor || typeof capacitor !== "object") {
    return false;
  }
  const plugins: unknown = Reflect.get(capacitor as object, "Plugins");
  const bgRunner: unknown =
    plugins && typeof plugins === "object"
      ? Reflect.get(plugins as object, "BackgroundRunner")
      : undefined;
  return typeof bgRunner === "object" && bgRunner !== null;
}

export function detectHostCapabilities(
  probe: HostCapabilityProbe = readDefaultHostCapabilityProbe(),
): HostCapabilities {
  if (probe.userAgent?.includes("Cloudflare-Workers")) {
    return {
      kind: "cloudflare-worker",
      fs: false,
      inbound: true,
      longRunning: false,
      childProcess: false,
      net: false,
      isMobile: false,
      isBrowser: false,
      label: "Cloudflare Worker",
    };
  }

  if (probe.capacitor && typeof probe.capacitor === "object") {
    const hasBgRunner = hasCapacitorBackgroundRunner(probe.capacitor);
    return {
      kind: hasBgRunner
        ? "capacitor-background-runner"
        : "capacitor-foreground-only",
      fs: false,
      inbound: false,
      longRunning: hasBgRunner,
      childProcess: false,
      net: false,
      isMobile: true,
      isBrowser: false,
      label: hasBgRunner
        ? "Mobile (Capacitor + BackgroundRunner)"
        : "Mobile (Capacitor, foreground-only)",
    };
  }

  if (probe.hasWindow && !probe.hasProcess) {
    return {
      kind: "browser",
      fs: false,
      inbound: false,
      longRunning: false,
      childProcess: false,
      net: false,
      isMobile: false,
      isBrowser: true,
      label: "Browser",
    };
  }

  return {
    kind: "node",
    fs: true,
    inbound: true,
    longRunning: true,
    childProcess: true,
    net: true,
    isMobile: false,
    isBrowser: false,
    label: "Node",
  };
}
