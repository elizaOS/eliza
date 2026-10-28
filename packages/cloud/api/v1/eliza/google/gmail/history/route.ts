/** Read-only owner Gmail delta feed; clients commit checkpoints after durable local persistence. */
import {
  requirePrivateOwnerAccess,
  requireUserOrApiKeyWithOrg,
} from "@elizaos/cloud-shared/auth";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import { fetchManagedGoogleGmailHistory } from "@elizaos/cloud-shared/lib/services/agent-google-connector";
import { AgentGoogleConnectorError } from "@elizaos/cloud-shared/lib/services/agent-google-connector/shared";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

const app = new Hono<AppEnv>();
app.get("/", async (c) => {
  c.header("Cache-Control", "no-store");
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    await requirePrivateOwnerAccess(c, user);
    const query = new URL(c.req.url).searchParams;
    const allowed = new Set([
      "grantId",
      "startHistoryId",
      "pageToken",
      "maxResults",
      "side",
    ]);
    for (const key of query.keys()) {
      if (!allowed.has(key) || query.getAll(key).length !== 1)
        return c.json(
          { error: "Unexpected or duplicate history parameter." },
          400,
        );
    }
    if (query.has("side") && query.get("side") !== "owner")
      return c.json({ error: "Gmail history requires owner access." }, 400);
    const maximum = query.get("maxResults");
    if (maximum !== null && !/^[1-9][0-9]{0,2}$/.test(maximum))
      return c.json({ error: "Invalid maxResults." }, 400);
    return c.json(
      await fetchManagedGoogleGmailHistory({
        organizationId: user.organization_id,
        userId: user.id,
        grantId: query.get("grantId") ?? "",
        ...(query.has("startHistoryId")
          ? { startHistoryId: query.get("startHistoryId")! }
          : {}),
        ...(query.has("pageToken")
          ? { pageToken: query.get("pageToken")! }
          : {}),
        ...(maximum !== null ? { maxResults: Number(maximum) } : {}),
      }),
    );
  } catch (error) {
    if (error instanceof AgentGoogleConnectorError)
      return c.json({ error: error.message }, error.status as 400);
    return failureResponse(c, error);
  }
});
export default app;
