import type { Metadata } from "next";
import { cookies } from "next/headers";
import { requireAuth } from "@/lib/auth";
import { anonymousSessionsService } from "@/lib/services/anonymous-sessions";
import { migrateAnonymousSession } from "@/lib/session";
import { MyAgentsClient } from "./my-agents";
import { generatePageMetadata, ROUTE_METADATA } from "@/lib/seo";
import { logger } from "@/lib/utils/logger";

export const metadata: Metadata = generatePageMetadata({
  ...ROUTE_METADATA.myAgents,
  path: "/dashboard/my-agents",
  noIndex: true,
});

export const dynamic = "force-dynamic";

/**
 * My Agents page displaying the user's characters/agents.
 * Handles server-side migration of anonymous session data to authenticated user.
 *
 * @returns The rendered my agents page client component.
 */
export default async function MyAgentsPage() {
  const user = await requireAuth();

  // Server-side migration check: if user has an anonymous session cookie, migrate it
  const cookieStore = await cookies();
  const anonSessionCookie = cookieStore.get("eliza-anon-session");

  if (anonSessionCookie?.value && user.privy_user_id) {
    logger.info(
      "[MyAgents] Found anonymous session cookie, attempting migration",
      {
        userId: user.id,
        sessionToken: anonSessionCookie.value.slice(0, 8) + "...",
      },
    );

    const anonSession = await anonymousSessionsService.getByToken(
      anonSessionCookie.value,
    );

    if (anonSession && !anonSession.converted_at) {
      logger.info("[MyAgents] Found unconverted session, migrating...", {
        sessionId: anonSession.id,
        anonymousUserId: anonSession.user_id,
      });

      await migrateAnonymousSession(anonSession.user_id, user.privy_user_id);

      logger.info("[MyAgents] Migration completed successfully");
    }
  }

  return <MyAgentsClient />;
}
