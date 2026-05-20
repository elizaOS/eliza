import {
  type AuthResult,
  getServerApiKey,
  validateApiKeyAsync,
} from "@feed/a2a";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

export async function checkApiKey(
  request: NextRequest,
  realm = "Feed",
): Promise<{
  error?: NextResponse;
  authResult?: AuthResult;
}> {
  const authResult = await validateApiKeyAsync(
    {
      headers: {
        get: (name: string) => request.headers.get(name),
      },
      host: request.headers.get("host") ?? undefined,
    },
    {
      serverApiKey: getServerApiKey(),
      allowUserApiKeys: true,
      // Only allow localhost bypass in non-production to prevent Host header spoofing
      allowLocalhost: process.env.NODE_ENV !== "production",
    },
  );

  if (!authResult.authenticated) {
    return {
      error: NextResponse.json(
        { error: authResult.error },
        {
          status: authResult.statusCode || 401,
          headers:
            authResult.statusCode === 401
              ? {
                  "WWW-Authenticate": `ApiKey realm="${realm}", header="X-Feed-Api-Key"`,
                }
              : undefined,
        },
      ),
    };
  }

  return { authResult };
}
