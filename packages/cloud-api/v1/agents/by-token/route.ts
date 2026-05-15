/**
 * GET /api/v1/agents/by-token?address=<token>&chain=<chain>
 *
 * Public lookup: resolves a token address (+ optional chain) to the canonical
 * public agent linked to it.
 */

import { Hono } from "hono";
import { userCharactersRepository } from "@/db/repositories/characters";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { normalizeTokenAddress } from "@/lib/utils/token-address";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    const address = c.req.query("address");
    const chain = c.req.query("chain") || undefined;

    if (!address) {
      return c.json({ success: false, error: "Missing required query parameter: address" }, 400);
    }
    if (address.length > 256) {
      return c.json(
        { success: false, error: "address parameter exceeds maximum length (256)" },
        400,
      );
    }
    if (chain && chain.length > 50) {
      return c.json({ success: false, error: "chain parameter exceeds maximum length (50)" }, 400);
    }

    const character = await userCharactersRepository.findByTokenAddress(
      normalizeTokenAddress(address, chain),
      chain,
    );

    if (!character || !character.is_public) {
      return c.json({ success: false, error: "No agent linked to this token" }, 404);
    }

    return c.json({
      success: true,
      data: {
        id: character.id,
        name: character.name,
        username: character.username ?? null,
        avatar_url: character.avatar_url ?? null,
        bio: character.bio,
        is_public: character.is_public,
        token_address: character.token_address,
        token_chain: character.token_chain,
        token_name: character.token_name,
        token_ticker: character.token_ticker,
        created_at: character.created_at,
      },
    });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
