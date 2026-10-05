/**
 * Wallet export helpers extracted from server.ts.
 */

import type http from "node:http";
import type {
  WalletExportRejection,
  WalletExportRequestBody,
} from "@elizaos/contracts";
import { readAliasedEnv } from "@elizaos/host/protocol";
import { tokenMatches } from "./server-helpers-auth.ts";

export type { WalletExportRejection };

// ---------------------------------------------------------------------------
// Wallet export rejection
// ---------------------------------------------------------------------------

export function resolveWalletExportRejection(
  req: http.IncomingMessage,
  body: WalletExportRequestBody,
): WalletExportRejection | null {
  if (!body.confirm) {
    return {
      status: 403,
      reason:
        'Export requires explicit confirmation. Send { "confirm": true } in the request body.',
    };
  }

  const expected = readAliasedEnv("ELIZA_WALLET_EXPORT_TOKEN");
  if (!expected) {
    return {
      status: 403,
      reason:
        "Wallet export is disabled. Set ELIZA_WALLET_EXPORT_TOKEN to enable secure exports.",
    };
  }

  const headerToken =
    typeof req.headers["x-eliza-export-token"] === "string"
      ? req.headers["x-eliza-export-token"].trim()
      : "";
  const bodyToken =
    typeof body.exportToken === "string" ? body.exportToken.trim() : "";
  const provided = headerToken || bodyToken;

  if (!provided) {
    return {
      status: 401,
      reason:
        "Missing export token. Provide X-Eliza-Export-Token header or exportToken in request body.",
    };
  }

  if (!tokenMatches(expected, provided)) {
    return { status: 401, reason: "Invalid export token." };
  }

  return null;
}
