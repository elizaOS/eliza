import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "@/types/cloud-worker-env";

function stripStewardPrefix(pathname: string): string {
  if (pathname === "/steward") return "/";
  if (pathname.startsWith("/steward/")) return pathname.slice("/steward".length);
  return pathname;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export const PUBLIC_STEWARD_TENANT_CONFIG = {
  features: {
    showFundingQR: true,
    showTransactionHistory: true,
    showSpendDashboard: true,
    showPolicyControls: true,
    showApprovalQueue: true,
    showSecretManager: false,
    enableSolana: true,
    showChainSelector: false,
    allowAddressExport: true,
  },
};

export function isPublicStewardTenantConfigPath(pathname: string): boolean {
  return stripStewardPrefix(pathname).replace(/\/+$/, "") === "/tenants/config";
}

function isAuthProvidersPath(pathname: string): boolean {
  return stripStewardPrefix(pathname).replace(/\/+$/, "") === "/auth/providers";
}

function resolveStewardUpstream(env: AppEnv["Bindings"], requestUrl: URL): string | null {
  const candidates = [env.STEWARD_API_URL, env.NEXT_PUBLIC_STEWARD_API_URL];
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || candidate.trim().length === 0) continue;
    try {
      const url = new URL(candidate.trim());
      if (url.protocol !== "https:" && url.protocol !== "http:") continue;
      if (url.origin === requestUrl.origin && url.pathname.replace(/\/+$/, "") === "/steward") {
        continue;
      }
      return trimTrailingSlash(url.toString());
    } catch {}
  }
  return null;
}

type ProvidersBody = {
  ok?: boolean;
  data?: {
    passkey?: boolean;
    email?: boolean;
    siwe?: boolean;
    siws?: boolean;
    google?: boolean;
    discord?: boolean;
    github?: boolean;
    oauth?: string[];
    [key: string]: unknown;
  };
};

function hasOAuthCreds(
  env: AppEnv["Bindings"],
  provider: "google" | "discord" | "github",
): boolean {
  const id = env[`${provider.toUpperCase()}_CLIENT_ID` as keyof typeof env];
  const secret = env[`${provider.toUpperCase()}_CLIENT_SECRET` as keyof typeof env];
  return typeof id === "string" && id.length > 0 && typeof secret === "string" && secret.length > 0;
}

/**
 * The deployed Steward 0.3.9 image's `/auth/providers` returns `false` for
 * google/discord/github even when the OAuth env vars are populated, while the
 * `/auth/oauth/<provider>/authorize` flow still works. Patch the proxied
 * response so the frontend renders the buttons that actually function.
 */
async function patchProvidersResponse(
  upstream: Response,
  env: AppEnv["Bindings"],
): Promise<Response> {
  if (!upstream.ok) return upstream;
  const contentType = upstream.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) return upstream;

  let parsed: ProvidersBody;
  try {
    parsed = (await upstream.clone().json()) as ProvidersBody;
  } catch {
    return upstream;
  }
  if (!parsed?.data) return upstream;

  const oauth = new Set<string>(parsed.data.oauth ?? []);
  const patched: ProvidersBody["data"] = { ...parsed.data };

  for (const provider of ["google", "discord", "github"] as const) {
    if (!patched[provider] && hasOAuthCreds(env, provider)) {
      patched[provider] = true;
      oauth.add(provider);
    }
  }
  patched.oauth = [...oauth];

  return Response.json(
    { ...parsed, data: patched },
    {
      status: upstream.status,
      headers: upstream.headers,
    },
  );
}

export const embeddedStewardHandler: MiddlewareHandler<AppEnv> = async (c) => {
  const url = new URL(c.req.url);
  if (c.req.method === "GET" && isPublicStewardTenantConfigPath(url.pathname)) {
    return c.json({ ok: true, data: PUBLIC_STEWARD_TENANT_CONFIG });
  }

  const upstream = resolveStewardUpstream(c.env, url);
  if (!upstream) {
    return c.json(
      {
        success: false,
        error: "steward_upstream_not_configured",
        message: "Set STEWARD_API_URL or NEXT_PUBLIC_STEWARD_API_URL to an external Steward API.",
      },
      503,
    );
  }

  const upstreamUrl = new URL(`${upstream}${stripStewardPrefix(url.pathname)}`);
  upstreamUrl.search = url.search;
  const request = new Request(upstreamUrl.toString(), c.req.raw);
  request.headers.set("x-forwarded-host", url.host);
  request.headers.set("x-forwarded-proto", url.protocol.replace(":", ""));

  const response = await fetch(request);
  if (c.req.method === "GET" && isAuthProvidersPath(url.pathname)) {
    return patchProvidersResponse(response, c.env);
  }
  return response;
};
