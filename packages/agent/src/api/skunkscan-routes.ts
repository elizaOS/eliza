import type http from "node:http";
import { investigateWallet } from "../skunkscan/wallet";
import { isSupportedChain, SUPPORTED_CHAINS, SupportedChain } from "../skunkscan/types";
import { buildTrustCheckCard } from "../skunkscan/analyzers/trustCheckCard";

type JsonHelper = (
  res: http.ServerResponse,
  data: unknown,
  status?: number,
) => void;

type ErrorHelper = (
  res: http.ServerResponse,
  message: string,
  status?: number,
) => void;

type ReadJsonBodyHelper = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
) => Promise<Record<string, unknown> | null>;

// Shared by both routes below - resolves and validates {chain, address} from
// the request body, or writes the appropriate error response itself and
// returns null so the caller just needs to check for that.
async function readWalletRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  helpers: {
    json: JsonHelper;
    readJsonBody: ReadJsonBodyHelper;
  },
): Promise<{ chain: SupportedChain; address: string } | null> {
  const body = await helpers.readJsonBody(req, res);
  if (!body) return null;

  const chain = typeof body.chain === "string" ? body.chain : "solana";
  const address = typeof body.address === "string" ? body.address : "";

  if (!isSupportedChain(chain)) {
    helpers.json(
      res,
      {
        error: "Unsupported chain",
        supportedChains: SUPPORTED_CHAINS,
      },
      400,
    );
    return null;
  }

  return { chain, address };
}

export async function handleSkunkScanRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  method: string,
  helpers: {
    json: JsonHelper;
    error: ErrorHelper;
    readJsonBody: ReadJsonBodyHelper;
  },
): Promise<boolean> {
  if (pathname === "/api/skunkscan/trust-check") {
    if (method !== "POST") {
      helpers.error(res, "Method not allowed", 405);
      return true;
    }

    const parsed = await readWalletRequest(req, res, helpers);
    if (!parsed) return true;

    const result = await investigateWallet(parsed.chain, parsed.address);
    const card = buildTrustCheckCard(result);

    helpers.json(res, card, result.status === "supported" ? 200 : 400);
    return true;
  }

  if (pathname !== "/api/skunkscan/wallet") {
    return false;
  }

  if (method !== "POST") {
    helpers.error(res, "Method not allowed", 405);
    return true;
  }

  const parsed = await readWalletRequest(req, res, helpers);
  if (!parsed) return true;

  const result = await investigateWallet(parsed.chain, parsed.address);

  helpers.json(res, result, result.status === "supported" ? 200 : 400);
  return true;
}
