import type { OpenClawConfig, GatewayBindMode } from "../config/config.js";
import { formatCliCommand } from "../cli/command-format.js";
// Note: Pairing allowlist is now managed via the Eliza runtime's PairingService
import { note } from "../terminal/note.js";

// Stub: Gateway functionality moved to plugins
function resolveGatewayAuth(params: {
  authConfig?: { mode?: string; token?: string; password?: string };
  env?: NodeJS.ProcessEnv;
  tailscaleMode?: string;
}): { mode: string; token?: string; password?: string } {
  const authConfig = params.authConfig;
  const mode = authConfig?.mode ?? "token";
  return {
    mode,
    token: params.env?.OPENCLAW_GATEWAY_TOKEN ?? authConfig?.token,
    password: params.env?.OPENCLAW_GATEWAY_PASSWORD ?? authConfig?.password,
  };
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase().trim();
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized.startsWith("127.")
  );
}

async function resolveGatewayBindHost(
  mode: GatewayBindMode,
  customHost?: string,
): Promise<string> {
  switch (mode) {
    case "loopback":
      return "127.0.0.1";
    case "lan":
    case "auto":
      return "0.0.0.0";
    case "custom":
      return customHost?.trim() || "127.0.0.1";
    case "tailnet":
      return "100.64.0.1"; // placeholder Tailscale IP
    default:
      return "127.0.0.1";
  }
}

export async function noteSecurityWarnings(cfg: OpenClawConfig) {
  const warnings: string[] = [];
  const auditHint = `- Run: ${formatCliCommand("openclaw security audit --deep")}`;

  // ===========================================
  // GATEWAY NETWORK EXPOSURE CHECK
  // ===========================================
  // Check for dangerous gateway binding configurations
  // that expose the gateway to network without proper auth

  const gatewayBind = (cfg.gateway?.bind ?? "loopback") as string;
  const customBindHost = cfg.gateway?.customBindHost?.trim();
  const bindModes: GatewayBindMode[] = ["auto", "lan", "loopback", "custom", "tailnet"];
  const bindMode = bindModes.includes(gatewayBind as GatewayBindMode)
    ? (gatewayBind as GatewayBindMode)
    : undefined;
  const resolvedBindHost = bindMode
    ? await resolveGatewayBindHost(bindMode, customBindHost)
    : "0.0.0.0";
  const isExposed = !isLoopbackHost(resolvedBindHost);

  const resolvedAuth = resolveGatewayAuth({
    authConfig: cfg.gateway?.auth,
    env: process.env,
    tailscaleMode: cfg.gateway?.tailscale?.mode ?? "off",
  });
  const authToken = resolvedAuth.token?.trim() ?? "";
  const authPassword = resolvedAuth.password?.trim() ?? "";
  const hasToken = authToken.length > 0;
  const hasPassword = authPassword.length > 0;
  const hasSharedSecret =
    (resolvedAuth.mode === "token" && hasToken) ||
    (resolvedAuth.mode === "password" && hasPassword);
  const bindDescriptor = `"${gatewayBind}" (${resolvedBindHost})`;

  if (isExposed) {
    if (!hasSharedSecret) {
      const authFixLines =
        resolvedAuth.mode === "password"
          ? [
              `  Fix: ${formatCliCommand("openclaw configure")} to set a password`,
              `  Or switch to token: ${formatCliCommand("openclaw config set gateway.auth.mode token")}`,
            ]
          : [
              `  Fix: ${formatCliCommand("openclaw doctor --fix")} to generate a token`,
              `  Or set token directly: ${formatCliCommand(
                "openclaw config set gateway.auth.mode token",
              )}`,
            ];
      warnings.push(
        `- CRITICAL: Gateway bound to ${bindDescriptor} without authentication.`,
        `  Anyone on your network (or internet if port-forwarded) can fully control your agent.`,
        `  Fix: ${formatCliCommand("openclaw config set gateway.bind loopback")}`,
        ...authFixLines,
      );
    } else {
      // Auth is configured, but still warn about network exposure
      warnings.push(
        `- WARNING: Gateway bound to ${bindDescriptor} (network-accessible).`,
        `  Ensure your auth credentials are strong and not exposed.`,
      );
    }
  }

  // Channel-specific security warnings are now handled by Eliza plugins.
  // Each channel plugin (e.g., @elizaos/plugin-telegram, @elizaos/plugin-discord)
  // is responsible for its own DM policy and security checks.

  const lines = warnings.length > 0 ? warnings : ["- No security warnings detected."];
  lines.push(auditHint);
  note(lines.join("\n"), "Security");
}
