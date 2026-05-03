import { Hono } from "hono";
import { failureResponse, jsonError } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { charactersService } from "@/lib/services/characters/characters";
import type { AppEnv } from "@/types/cloud-worker-env";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const app = new Hono<AppEnv>();

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const characterId = c.req.param("characterId") ?? "";
    if (!UUID_RE.test(characterId)) {
      return jsonError(c, 400, "Invalid character id", "validation_error");
    }

    const character = await charactersService.getByIdForUser(characterId, user.id);
    if (!character) {
      return jsonError(c, 404, "Character not found", "resource_not_found");
    }

    const mcpSettings = objectRecord(character.settings.mcp);
    const servers = objectRecord(mcpSettings?.servers) ?? {};
    const plugins = Array.isArray(character.plugins) ? character.plugins : [];

    return c.json({
      success: true,
      data: {
        characterId: character.id,
        enabled: character.mcp_enabled,
        endpoint: `/api/agents/${character.id}/mcp`,
        pluginInstalled: plugins.includes("@elizaos/plugin-mcp"),
        servers,
        serverCount: Object.keys(servers).length,
      },
    });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
