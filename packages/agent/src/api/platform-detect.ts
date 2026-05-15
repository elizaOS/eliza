/**
 * Server-side platform detection for the agent HTTP server.
 *
 * Used by view routes and plugin-install guards to decide whether dynamic
 * code loading is permitted. iOS App Store and Google Play builds prohibit
 * fetching and executing remote JavaScript at runtime.
 */

import type { IncomingMessage } from "node:http";

export type AgentPlatform = "web" | "desktop" | "ios" | "android";

/**
 * Detect the client platform from the incoming HTTP request.
 *
 * Resolution order:
 * 1. `X-Eliza-Platform` header — set by native Capacitor shells.
 * 2. `User-Agent` — Capacitor injects platform markers; Electrobun sets its own.
 * 3. Default: "web".
 */
export function detectClientPlatform(req: IncomingMessage): AgentPlatform {
  const headers = req.headers ?? {};
  const header = headers["x-eliza-platform"];
  if (header === "ios") return "ios";
  if (header === "android") return "android";

  const ua = (headers["user-agent"] as string | undefined) ?? "";
  if (/Capacitor.*iOS/i.test(ua)) return "ios";
  if (/Capacitor.*Android/i.test(ua)) return "android";
  if (/Electrobun/i.test(ua)) return "desktop";

  return "web";
}

/**
 * Returns true when the platform allows dynamic JS loading at runtime.
 *
 * iOS App Store and Google Play policies prohibit apps from downloading and
 * executing JavaScript not bundled with the binary at submission time.
 */
export function isDynamicLoadingAllowed(platform: AgentPlatform): boolean {
  return platform !== "ios" && platform !== "android";
}
