/**
 * POST /api/auth/steward/oauth/exchange
 *
 * Server-side half of Feed's Steward `response_type=code` OAuth flow.
 * The browser callback page POSTs the one-time code + PKCE verifier here;
 * we forward to Steward `POST /auth/oauth/exchange` and return tokens.
 */

import { withErrorHandling } from "@feed/api";
import { type NextRequest, NextResponse } from "next/server";
import { signStewardMutatingRequest } from "@/lib/auth/steward-request-sign";
import { STEWARD_API_URL } from "@/lib/auth/steward-server";

const DEFAULT_TENANT_ID =
  process.env.STEWARD_TENANT_ID ??
  process.env.NEXT_PUBLIC_STEWARD_TENANT_ID ??
  "feed";

type ExchangeBody = {
  code?: string;
  redirectUri?: string;
  tenantId?: string;
  codeVerifier?: string;
};

type StewardExchangeOk = {
  ok: true;
  token: string;
  refreshToken?: string;
};

type StewardExchangeErr = {
  ok: false;
  error?: string;
  code?: string;
};

async function callStewardExchange(body: {
  code: string;
  redirect_uri: string;
  tenant_id: string;
  code_verifier: string;
}): Promise<
  | { kind: "ok"; data: StewardExchangeOk }
  | { kind: "error"; status: number; data: StewardExchangeErr }
  | { kind: "transport"; message: string }
> {
  const exchangeUrl = new URL(`${STEWARD_API_URL}/auth/oauth/exchange`);
  const headers = new Headers({
    "Content-Type": "application/json",
    Accept: "application/json",
    "X-Steward-Tenant": body.tenant_id,
  });
  const bodyText = JSON.stringify(body);
  const bodyBytes = new TextEncoder().encode(bodyText);

  const signingSecret = process.env.STEWARD_REQUEST_SIGNING_SECRET?.trim();
  if (signingSecret) {
    await signStewardMutatingRequest(
      signingSecret,
      "POST",
      `${exchangeUrl.pathname}${exchangeUrl.search}`,
      headers,
      bodyBytes,
    );
  }

  let response: Response;
  try {
    response = await fetch(exchangeUrl.toString(), {
      method: "POST",
      headers,
      body: bodyText,
    });
  } catch (err) {
    return {
      kind: "transport",
      message: err instanceof Error ? err.message : String(err),
    };
  }

  const text = await response.text();
  let parsed: StewardExchangeOk | StewardExchangeErr | null = null;
  try {
    parsed = text
      ? (JSON.parse(text) as StewardExchangeOk | StewardExchangeErr)
      : null;
  } catch {
    parsed = null;
  }

  if (!response.ok || !parsed || parsed.ok !== true) {
    return {
      kind: "error",
      status: response.status,
      data: (parsed as StewardExchangeErr) ?? {
        ok: false,
        error: text || "Steward exchange failed",
      },
    };
  }

  return { kind: "ok", data: parsed };
}

export const POST = withErrorHandling(async (req: NextRequest) => {
  let body: ExchangeBody;
  try {
    body = (await req.json()) as ExchangeBody;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid request body" },
      { status: 400 },
    );
  }

  const code = typeof body.code === "string" ? body.code.trim() : "";
  const redirectUri =
    typeof body.redirectUri === "string" ? body.redirectUri.trim() : "";
  const tenantId =
    typeof body.tenantId === "string" && body.tenantId.trim().length > 0
      ? body.tenantId.trim()
      : DEFAULT_TENANT_ID;
  const codeVerifier =
    typeof body.codeVerifier === "string" ? body.codeVerifier.trim() : "";

  if (!code) {
    return NextResponse.json(
      { ok: false, error: "code is required", code: "missing_code" },
      { status: 400 },
    );
  }
  if (!redirectUri) {
    return NextResponse.json(
      { ok: false, error: "redirectUri is required" },
      { status: 400 },
    );
  }
  if (!codeVerifier) {
    return NextResponse.json(
      { ok: false, error: "codeVerifier is required" },
      { status: 400 },
    );
  }

  const result = await callStewardExchange({
    code,
    redirect_uri: redirectUri,
    tenant_id: tenantId,
    code_verifier: codeVerifier,
  });

  if (result.kind === "transport") {
    return NextResponse.json(
      {
        ok: false,
        error: "Steward upstream unavailable",
        code: "steward_upstream_unavailable",
      },
      { status: 502 },
    );
  }

  if (result.kind === "error") {
    return NextResponse.json(
      {
        ok: false,
        error: result.data.error ?? "Steward exchange failed",
        code: result.data.code ?? "exchange_failed",
      },
      { status: result.status >= 400 ? result.status : 502 },
    );
  }

  return NextResponse.json({
    ok: true,
    token: result.data.token,
    refreshToken: result.data.refreshToken ?? null,
  });
});
