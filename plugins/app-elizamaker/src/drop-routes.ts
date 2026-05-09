import type http from "node:http";
import type { ReadJsonBodyOptions } from "@elizaos/shared";
import type { DropService } from "./drop-service.js";
import { buildWhitelistTree, generateProof } from "./merkle-tree.js";
import {
  generateVerificationMessage,
  isAddressWhitelisted,
  markAddressVerified,
  verifyTweet,
} from "./twitter-verify.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DropRouteContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  method: string;
  pathname: string;
  url: URL;
  json: (res: http.ServerResponse, data: unknown, status?: number) => void;
  error: (res: http.ServerResponse, message: string, status?: number) => void;
  readJsonBody: <T extends object>(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    options?: ReadJsonBodyOptions,
  ) => Promise<T | null>;
  dropService: DropService | null;
  agentName: string;
  getWalletAddresses: () => { evmAddress?: string; solanaAddress?: string };
  readOGCodeFromState: () => string | null;
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function handleDropRoutes(
  ctx: DropRouteContext,
): Promise<boolean> {
  const {
    req,
    res,
    method,
    pathname,
    json,
    error,
    readJsonBody,
    dropService,
    agentName,
    getWalletAddresses,
    readOGCodeFromState,
  } = ctx;

  // ═══════════════════════════════════════════════════════════════════════
  //  Drop / Mint Routes
  // ═══════════════════════════════════════════════════════════════════════

  if (method === "GET" && pathname === "/api/drop/status") {
    if (!dropService) {
      json(res, {
        dropEnabled: false,
        publicMintOpen: false,
        whitelistMintOpen: false,
        mintedOut: false,
        currentSupply: 0,
        maxSupply: 2138,
        shinyPrice: "0.1",
        userHasMinted: false,
      });
      return true;
    }
    const status = await dropService.getStatus();
    json(res, status);
    return true;
  }

  if (method === "POST" && pathname === "/api/drop/mint") {
    if (!dropService) {
      error(res, "Drop service not configured.", 503);
      return true;
    }
    const body = await readJsonBody<{
      name?: string;
      endpoint?: string;
      shiny?: boolean;
    }>(req, res);
    if (!body) return true;

    const name = body.name || agentName || "Eliza";
    const endpoint = body.endpoint || "";

    const result = body.shiny
      ? await dropService.mintShiny(name, endpoint)
      : await dropService.mint(name, endpoint);
    json(res, result);
    return true;
  }

  if (method === "POST" && pathname === "/api/drop/mint-whitelist") {
    if (!dropService) {
      error(res, "Drop service not configured.", 503);
      return true;
    }
    const body = await readJsonBody<{
      name?: string;
      endpoint?: string;
      proof?: string[];
    }>(req, res);
    if (!body) return true;
    let proof = body.proof;
    if (!proof || proof.length === 0) {
      const addrs = getWalletAddresses();
      const walletAddress = addrs.evmAddress ?? "";
      if (!walletAddress) {
        error(res, "EVM wallet not configured.");
        return true;
      }
      const proofResult = generateProof(walletAddress);
      if (!proofResult.isWhitelisted) {
        error(
          res,
          "Address not whitelisted. Complete Twitter or NFT verification first.",
        );
        return true;
      }
      proof = proofResult.proof;
    }

    const name = body.name || agentName || "Eliza";
    const endpoint = body.endpoint || "";
    const result = await dropService.mintWithWhitelist(name, endpoint, proof);
    json(res, result);
    return true;
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  Whitelist Routes
  // ═══════════════════════════════════════════════════════════════════════

  if (method === "GET" && pathname === "/api/whitelist/status") {
    const addrs = getWalletAddresses();
    const walletAddress = addrs.evmAddress ?? "";
    const twitterVerified = walletAddress
      ? isAddressWhitelisted(walletAddress)
      : false;
    const ogCode = readOGCodeFromState();

    const { info } = buildWhitelistTree();
    const proofReady = walletAddress
      ? generateProof(walletAddress).isWhitelisted
      : false;

    json(res, {
      eligible: twitterVerified,
      twitterVerified,
      nftVerified: twitterVerified,
      whitelisted: walletAddress ? isAddressWhitelisted(walletAddress) : false,
      ogCode: ogCode ?? null,
      walletAddress,
      merkle: {
        root: info.root,
        addressCount: info.addressCount,
        proofReady,
      },
    });
    return true;
  }

  if (method === "POST" && pathname === "/api/whitelist/twitter/message") {
    const addrs = getWalletAddresses();
    const walletAddress = addrs.evmAddress ?? "";
    if (!walletAddress) {
      error(res, "EVM wallet not configured. Complete onboarding first.");
      return true;
    }
    const name = agentName || "Eliza";
    const message = generateVerificationMessage(name, walletAddress);
    json(res, { message, walletAddress });
    return true;
  }

  if (method === "POST" && pathname === "/api/whitelist/twitter/verify") {
    const body = await readJsonBody<{ tweetUrl?: string }>(req, res);
    if (!body?.tweetUrl) {
      error(res, "tweetUrl is required");
      return true;
    }

    const addrs = getWalletAddresses();
    const walletAddress = addrs.evmAddress ?? "";
    if (!walletAddress) {
      error(res, "EVM wallet not configured.");
      return true;
    }

    const result = await verifyTweet(body.tweetUrl, walletAddress);
    if (result.verified && result.handle) {
      markAddressVerified(walletAddress, body.tweetUrl, result.handle);
    }
    json(res, result);
    return true;
  }

  if (method === "GET" && pathname === "/api/whitelist/merkle/root") {
    const { info } = buildWhitelistTree();
    json(res, {
      root: info.root,
      addressCount: info.addressCount,
      proofReady: true,
    });
    return true;
  }

  if (method === "GET" && pathname === "/api/whitelist/merkle/proof") {
    const reqUrl = new URL(req.url ?? "", `http://${req.headers.host}`);
    const addr = reqUrl.searchParams.get("address");
    if (!addr) {
      error(res, "address query parameter is required", 400);
      return true;
    }
    const result = generateProof(addr);
    json(res, result);
    return true;
  }

  return false;
}
