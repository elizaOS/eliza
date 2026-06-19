import { type NextRequest, NextResponse } from "next/server";

/**
 * Server-side proxy for the ElizaOS Cloud affiliate create-character API.
 *
 * The affiliate API key carries the privileged "affiliate:create-character"
 * permission, so it must never reach the browser. This route reads it from the
 * SERVER-ONLY `AFFILIATE_API_KEY` env var (not `NEXT_PUBLIC_*`), attaches the
 * Bearer header here, and forwards the request to Cloud. The client calls this
 * same-origin route instead of hitting Cloud directly with the key.
 */
export async function POST(req: NextRequest) {
  const affiliateApiKey = process.env.AFFILIATE_API_KEY;
  if (!affiliateApiKey) {
    console.error("AFFILIATE_API_KEY is not configured");
    return NextResponse.json(
      { success: false, error: "Affiliate API key is not configured" },
      { status: 500 },
    );
  }

  const cloudUrl =
    process.env.ELIZA_CLOUD_URL ||
    process.env.NEXT_PUBLIC_ELIZA_CLOUD_URL ||
    "http://localhost:3000";

  try {
    const body = await req.json();

    const response = await fetch(`${cloudUrl}/api/affiliate/create-character`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${affiliateApiKey}`,
      },
      body: JSON.stringify(body),
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      console.error("Cloud affiliate API error:", response.status, data);
      return NextResponse.json(
        {
          success: false,
          error: data.error || "Failed to create character in Cloud",
        },
        { status: response.status },
      );
    }

    // Pass the Cloud response through verbatim (success, characterId, ...).
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error("Error proxying affiliate create-character:", error);
    return NextResponse.json(
      { success: false, error: "Failed to create character" },
      { status: 500 },
    );
  }
}
