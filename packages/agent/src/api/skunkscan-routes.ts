import type http from "node:http";
import { investigateWallet } from "../skunkscan/wallet";

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
  if (pathname !== "/api/skunkscan/wallet") {
    return false;
  }

  if (method !== "POST") {
    helpers.error(res, "Method not allowed", 405);
    return true;
  }

  const body = await helpers.readJsonBody(req, res);
  if (!body) return true;

  const chain = typeof body.chain === "string" ? body.chain : "solana";
  const address = typeof body.address === "string" ? body.address : "";

  if (chain !== "solana" && chain !== "ethereum" && chain !== "base" && chain !== "bnb") {
    helpers.json(
      res,
      {
        error: "Unsupported chain",
        supportedChains: ["solana", "ethereum", "base", "bnb"],
      },
      400,
    );
    return true;
  }

  const result = await investigateWallet(chain, address);

  helpers.json(res, result, result.status === "supported" ? 200 : 400);
  return true;
}
