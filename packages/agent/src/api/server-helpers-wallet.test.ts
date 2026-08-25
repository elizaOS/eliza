/**
 * Unit tests for `resolveWalletExportRejection`, the wallet private-key export
 * gate. Confirmation, env-token presence, header-vs-body token selection,
 * trim, length-mismatch, and timing-safe compare are pinned against the real
 * helper — no mocked crypto or env reader.
 */
import type http from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveWalletExportRejection } from "./server-helpers-wallet.ts";

const ENV_KEYS = ["ELIZA_WALLET_EXPORT_TOKEN"] as const;
const TOKEN = "wallet-export-secret";

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function asReq(headers: http.IncomingHttpHeaders = {}): http.IncomingMessage {
  return { headers } as unknown as http.IncomingMessage;
}

describe("resolveWalletExportRejection", () => {
  it("rejects an unconfirmed export before looking at tokens", () => {
    process.env.ELIZA_WALLET_EXPORT_TOKEN = TOKEN;
    const expected = {
      status: 403,
      reason:
        'Export requires explicit confirmation. Send { "confirm": true } in the request body.',
    };

    expect(resolveWalletExportRejection(asReq(), {})).toEqual(expected);
    expect(resolveWalletExportRejection(asReq(), { confirm: false })).toEqual(
      expected,
    );
    expect(
      resolveWalletExportRejection(asReq({ "x-eliza-export-token": TOKEN }), {
        confirm: false,
        exportToken: TOKEN,
      }),
    ).toEqual(expected);
  });

  it("disables export when ELIZA_WALLET_EXPORT_TOKEN is unset or empty", () => {
    const expected = {
      status: 403,
      reason:
        "Wallet export is disabled. Set ELIZA_WALLET_EXPORT_TOKEN to enable secure exports.",
    };

    expect(resolveWalletExportRejection(asReq(), { confirm: true })).toEqual(
      expected,
    );

    process.env.ELIZA_WALLET_EXPORT_TOKEN = "";
    expect(
      resolveWalletExportRejection(asReq({ "x-eliza-export-token": TOKEN }), {
        confirm: true,
        exportToken: TOKEN,
      }),
    ).toEqual(expected);
  });

  it("returns 401 when a configured token is missing from both header and body", () => {
    process.env.ELIZA_WALLET_EXPORT_TOKEN = TOKEN;
    const expected = {
      status: 401,
      reason:
        "Missing export token. Provide X-Eliza-Export-Token header or exportToken in request body.",
    };

    expect(resolveWalletExportRejection(asReq(), { confirm: true })).toEqual(
      expected,
    );
    expect(
      resolveWalletExportRejection(asReq({ "x-eliza-export-token": "   " }), {
        confirm: true,
        exportToken: "\t",
      }),
    ).toEqual(expected);
    expect(
      resolveWalletExportRejection(
        asReq({ "x-eliza-export-token": ["not-a-string-header"] }),
        { confirm: true, exportToken: 12 as unknown as string },
      ),
    ).toEqual(expected);
  });

  it("accepts a matching header token", () => {
    process.env.ELIZA_WALLET_EXPORT_TOKEN = TOKEN;
    expect(
      resolveWalletExportRejection(asReq({ "x-eliza-export-token": TOKEN }), {
        confirm: true,
      }),
    ).toBeNull();
  });

  it("accepts a matching body token when the header is absent", () => {
    process.env.ELIZA_WALLET_EXPORT_TOKEN = TOKEN;
    expect(
      resolveWalletExportRejection(asReq(), {
        confirm: true,
        exportToken: TOKEN,
      }),
    ).toBeNull();
  });

  it("trims header and body tokens before comparing", () => {
    process.env.ELIZA_WALLET_EXPORT_TOKEN = TOKEN;
    expect(
      resolveWalletExportRejection(
        asReq({ "x-eliza-export-token": `  ${TOKEN}  ` }),
        { confirm: true },
      ),
    ).toBeNull();
    expect(
      resolveWalletExportRejection(asReq(), {
        confirm: true,
        exportToken: `\n${TOKEN}\t`,
      }),
    ).toBeNull();
  });

  it("prefers the header token over a body token", () => {
    process.env.ELIZA_WALLET_EXPORT_TOKEN = TOKEN;
    expect(
      resolveWalletExportRejection(
        asReq({ "x-eliza-export-token": "wrong-header" }),
        { confirm: true, exportToken: TOKEN },
      ),
    ).toEqual({ status: 401, reason: "Invalid export token." });
    expect(
      resolveWalletExportRejection(asReq({ "x-eliza-export-token": TOKEN }), {
        confirm: true,
        exportToken: "wrong-body",
      }),
    ).toBeNull();
  });

  it("falls back to the body token when the header is not a string", () => {
    process.env.ELIZA_WALLET_EXPORT_TOKEN = TOKEN;
    expect(
      resolveWalletExportRejection(asReq({ "x-eliza-export-token": [TOKEN] }), {
        confirm: true,
        exportToken: TOKEN,
      }),
    ).toBeNull();
  });

  it("rejects a same-length mismatch and a different-length mismatch", () => {
    process.env.ELIZA_WALLET_EXPORT_TOKEN = TOKEN;
    const expected = { status: 401, reason: "Invalid export token." };

    // Same length, different bytes — timingSafeEqual path.
    expect(
      resolveWalletExportRejection(
        asReq({ "x-eliza-export-token": "wallet-export-SECRET" }),
        { confirm: true },
      ),
    ).toEqual(expected);
    // Different length — tokenMatches returns false before timingSafeEqual.
    expect(
      resolveWalletExportRejection(asReq(), {
        confirm: true,
        exportToken: "short",
      }),
    ).toEqual(expected);
    expect(
      resolveWalletExportRejection(asReq(), {
        confirm: true,
        exportToken: `${TOKEN}-extra`,
      }),
    ).toEqual(expected);
  });

  it("treats a whitespace-padded env token as its trimmed value", () => {
    process.env.ELIZA_WALLET_EXPORT_TOKEN = ` ${TOKEN} `;
    expect(
      resolveWalletExportRejection(asReq({ "x-eliza-export-token": TOKEN }), {
        confirm: true,
      }),
    ).toBeNull();
  });

  it("treats a whitespace-only env token as unset and disables export", () => {
    process.env.ELIZA_WALLET_EXPORT_TOKEN = "   ";
    expect(
      resolveWalletExportRejection(asReq({ "x-eliza-export-token": TOKEN }), {
        confirm: true,
      }),
    ).toEqual({
      status: 403,
      reason:
        "Wallet export is disabled. Set ELIZA_WALLET_EXPORT_TOKEN to enable secure exports.",
    });
  });
});
