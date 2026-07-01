/**
 * Embed launch — full local end-to-end (#9947).
 *
 * Exercises the whole seam with REAL crypto (no live platform client): a
 * correctly-signed Telegram `initData` → `verifyEmbedLaunch` (HMAC + role gate)
 * → `mintEmbedSessionToken` → `verifyEmbedSessionToken`. Proves the verified
 * principal flows end-to-end and that a forged launch never yields a token.
 */

import { createHmac } from "node:crypto";
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";

const hasRoleAccess = vi.fn(
  async (_runtime: unknown, _message: unknown, role: string) =>
    role === "OWNER",
);

import { verifyEmbedLaunch } from "./embed-handshake.ts";
import {
  mintEmbedSessionToken,
  verifyEmbedSessionToken,
} from "./embed-session-token.ts";

const BOT_TOKEN = "123456:test-bot-token";
const EMBED_SECRET = "embed-session-secret-16+chars";
const NOW = 1_700_000_000_000;

function makeRuntime(): IAgentRuntime {
  return {
    agentId: "33333333-3333-3333-3333-333333333333",
    getSetting: (key: string) =>
      key === "TELEGRAM_BOT_TOKEN" ? BOT_TOKEN : null,
    logger: { warn() {}, info() {}, debug() {}, error() {} },
  } as unknown as IAgentRuntime;
}

/** Build a real, correctly-signed Telegram initData query string. */
function buildTelegramInitData(authDateMs: number): string {
  const fields: Record<string, string> = {
    auth_date: String(Math.floor(authDateMs / 1000)),
    query_id: "AAA",
    user: JSON.stringify({ id: 424242, first_name: "Ada" }),
  };
  const dataCheckString = Object.keys(fields)
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join("\n");
  const secretKey = createHmac("sha256", "WebAppData")
    .update(BOT_TOKEN)
    .digest();
  const hash = createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex");
  const params = new URLSearchParams(fields);
  params.set("hash", hash);
  return params.toString();
}

describe("embed launch — full local end-to-end (#9947)", () => {
  it("real initData → verified OWNER principal → minted token → verified token", async () => {
    hasRoleAccess.mockImplementation(
      async (_rt, _msg, role) => role === "OWNER",
    );
    const runtime = makeRuntime();

    const initData = buildTelegramInitData(NOW);
    const verified = await verifyEmbedLaunch(
      { platform: "telegram", signedLaunchPayload: initData },
      runtime,
      NOW + 1000,
      { hasRoleAccess },
    );
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(verified.role).toBe("OWNER");
    expect(verified.adminMode).toBe(true);
    expect(typeof verified.entityId).toBe("string");

    // Mint the scoped credential from the verified principal, then verify it.
    const token = mintEmbedSessionToken(
      {
        entityId: verified.entityId,
        role: verified.role,
        adminMode: verified.adminMode,
        exp: NOW + 60_000,
      },
      EMBED_SECRET,
    );
    const claims = verifyEmbedSessionToken(token, EMBED_SECRET, NOW + 1000);
    expect(claims).not.toBeNull();
    expect(claims?.entityId).toBe(verified.entityId);
    expect(claims?.role).toBe("OWNER");
  });

  it("a forged launch never yields a token (fail closed)", async () => {
    const runtime = makeRuntime();
    const forged = buildTelegramInitData(NOW).replace(
      /hash=[0-9a-f]+/,
      "hash=deadbeefdeadbeef",
    );
    const verified = await verifyEmbedLaunch(
      { platform: "telegram", signedLaunchPayload: forged },
      runtime,
      NOW + 1000,
      { hasRoleAccess },
    );
    expect(verified.ok).toBe(false);
    // Nothing to mint — the seam stops before any credential is issued.
  });
});
