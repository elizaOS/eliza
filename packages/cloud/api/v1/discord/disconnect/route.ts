/**
 * Discord Disconnect API
 *
 * Disconnects the bot from a Discord guild or all guilds.
 */

import { requireUserOrApiKeyWithOrg } from "@elizaos/cloud-shared/auth";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import { discordAutomationService } from "@elizaos/cloud-shared/lib/services/discord-automation";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";
import { z } from "zod";

const app = new Hono<AppEnv>();

const disconnectSchema = z.object({
  guildId: z.string().optional(),
});

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);

    let body: z.infer<typeof disconnectSchema>;
    try {
      const rawBody = await c.req.json();
      body = disconnectSchema.parse(rawBody);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return c.json(
          { error: "Validation failed", details: error.flatten() },
          400,
        );
      }
      return c.json({ error: "Invalid request body" }, 400);
    }

    if (body.guildId) {
      // Disconnect specific guild
      const guild = await discordAutomationService.getGuild(
        user.organization_id,
        body.guildId,
      );
      if (!guild) {
        return c.json({ error: "Guild not found" }, 404);
      }

      const result = await discordAutomationService.disconnect(
        user.organization_id,
        body.guildId,
      );

      if (!result.success) {
        return c.json({ error: result.error }, 500);
      }

      logger.info("[Discord Disconnect] Guild disconnected", {
        organizationId: user.organization_id,
        guildId: body.guildId,
      });

      return c.json({ success: true });
    } else {
      // Disconnect all guilds
      await discordAutomationService.disconnectAll(user.organization_id);

      logger.info("[Discord Disconnect] All guilds disconnected", {
        organizationId: user.organization_id,
      });

      return c.json({ success: true });
    }
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
