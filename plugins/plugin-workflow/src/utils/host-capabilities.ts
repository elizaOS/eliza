/**
 * Host capability detection for the embedded workflow engine.
 *
 * Different host environments have different ceilings: Cloudflare Workers
 * have no fs/childProcess/long-running process; iOS/Android (Capacitor) have
 * no fs/childProcess and no public inbound HTTP without a tunnel; browsers
 * have neither fs nor inbound. The engine uses these to refuse activation
 * of workflows whose nodes need capabilities the host can't provide, with
 * an actionable message suggesting the right remediation (paired Eliza
 * Cloud, plugin-tunnel, or running on a server agent).
 */

export interface HostCapabilities {
  /** Read/write filesystem via node:fs (or equivalent). */
  fs: boolean;
  /** Can receive inbound HTTP from the public internet (host a webhook). */
  inbound: boolean;
  /** Host process stays alive across schedule firings (vs short-lived). */
  longRunning: boolean;
  /** Spawns child processes via node:child_process. */
  childProcess: boolean;
  /** Raw TCP/UDP sockets via node:net (vs only fetch). */
  net: boolean;
  /** Human-readable host label for error messages. */
  label: string;
}

declare const navigator: { userAgent?: string } | undefined;

export function detectHostCapabilities(): HostCapabilities {
  // Cloudflare Workers — runtime exposes navigator.userAgent === 'Cloudflare-Workers'.
  if (
    typeof navigator !== 'undefined' &&
    typeof navigator?.userAgent === 'string' &&
    navigator.userAgent.includes('Cloudflare-Workers')
  ) {
    return {
      fs: false,
      inbound: true, // Workers handle HTTP — webhook nodes can run if scheduling is the worker cron
      longRunning: false,
      childProcess: false,
      net: false,
      label: 'Cloudflare Worker',
    };
  }

  // Capacitor (iOS / Android). Capacitor exposes a global on the window/globalThis.
  const capacitor: unknown = Reflect.get(globalThis, 'Capacitor');
  if (capacitor && typeof capacitor === 'object') {
    return {
      fs: false,
      inbound: false, // No public HTTP without plugin-tunnel
      longRunning: true, // App stays alive while running; bg runner handles wake-ups
      childProcess: false,
      net: false,
      label: 'Mobile (Capacitor)',
    };
  }

  // Browser without Capacitor — pure web.
  if (typeof window !== 'undefined' && typeof process === 'undefined') {
    return {
      fs: false,
      inbound: false,
      longRunning: true,
      childProcess: false,
      net: false,
      label: 'Browser',
    };
  }

  // Node — server / desktop. Full power.
  return {
    fs: true,
    inbound: true,
    longRunning: true,
    childProcess: true,
    net: true,
    label: 'Node',
  };
}
