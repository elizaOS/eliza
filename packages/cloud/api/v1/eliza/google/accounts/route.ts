/**
 * GET /api/v1/eliza/google/accounts
 *
 * Lists managed Google connector accounts for the caller's organization.
 * `side` query param scopes the result to OWNER, AGENT, or TEAM accounts.
 */

import {
  requirePrivateOwnerAccess,
  requireUserOrApiKeyWithOrg,
} from "@elizaos/cloud-shared/auth";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import {
  AgentGoogleConnectorError,
  listManagedGoogleConnectorAccounts,
} from "@elizaos/cloud-shared/lib/services/agent-google-connector";
import {
  OAUTH_CONNECTION_ROLES,
  type OAuthStandardConnectionRole,
  parseOAuthConnectionRole,
} from "@elizaos/cloud-shared/lib/services/oauth";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

const app = new Hono<AppEnv>();
const ACCOUNT_ROLES = [
  ...OAUTH_CONNECTION_ROLES,
] satisfies OAuthStandardConnectionRole[];

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const rawSide = c.req.query("side") ?? null;
    const side = parseOAuthConnectionRole(rawSide);
    if (rawSide !== null && !side) {
      return c.json({ error: "side must be OWNER, AGENT, or TEAM." }, 400);
    }
    if (!side || side === "OWNER") await requirePrivateOwnerAccess(c, user);
    const sides = side ? [side] : ACCOUNT_ROLES;
    const accounts = (
      await Promise.all(
        sides.map((accountSide) =>
          listManagedGoogleConnectorAccounts({
            organizationId: user.organization_id,
            userId: user.id,
            side: accountSide,
          }),
        ),
      )
    ).flat();
    return c.json(accounts);
  } catch (error) {
    if (error instanceof AgentGoogleConnectorError) {
      return c.json({ error: error.message }, error.status as 400);
    }
    return failureResponse(c, error);
  }
});

export default app;
