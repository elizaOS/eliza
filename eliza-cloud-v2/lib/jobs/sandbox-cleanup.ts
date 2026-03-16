import { dbRead, dbWrite } from "@/db/client";
import { appSandboxSessions } from "@/db/schemas/app-sandboxes";
import { lt, and, notInArray, eq } from "drizzle-orm";
import { sandboxService } from "@/lib/services/sandbox";
import { logger } from "@/lib/utils/logger";

export async function cleanupExpiredSandboxes(): Promise<{
  cleaned: number;
  errors: number;
}> {
  const now = new Date();
  let cleaned = 0;
  let errors = 0;

  try {
    const expiredSessions = await dbRead.query.appSandboxSessions.findMany({
      where: and(
        lt(appSandboxSessions.expires_at, now),
        notInArray(appSandboxSessions.status, ["stopped", "timeout"]),
      ),
    });

    logger.info("Found expired sandbox sessions", {
      count: expiredSessions.length,
    });

    for (const session of expiredSessions) {
      try {
        if (session.sandbox_id) {
          try {
            await sandboxService.stop(session.sandbox_id);
          } catch (stopError) {
            logger.warn("Failed to stop sandbox (may already be stopped)", {
              sandboxId: session.sandbox_id,
              error: stopError,
            });
          }
        }

        await dbWrite
          .update(appSandboxSessions)
          .set({
            status: "timeout",
            stopped_at: now,
            updated_at: now,
          })
          .where(eq(appSandboxSessions.id, session.id));

        cleaned++;
        logger.info("Cleaned up expired session", {
          sessionId: session.id,
          sandboxId: session.sandbox_id,
        });
      } catch (sessionError) {
        errors++;
        logger.error("Failed to cleanup session", {
          sessionId: session.id,
          error: sessionError,
        });
      }
    }

    const activeSandboxIds = sandboxService.getActiveSandboxes();
    const activeSessions = await dbRead.query.appSandboxSessions.findMany({
      where: notInArray(appSandboxSessions.status, ["stopped", "timeout"]),
    });

    for (const session of activeSessions) {
      if (
        session.sandbox_id &&
        !activeSandboxIds.includes(session.sandbox_id)
      ) {
        try {
          await dbWrite
            .update(appSandboxSessions)
            .set({
              status: "timeout",
              stopped_at: now,
              updated_at: now,
            })
            .where(eq(appSandboxSessions.id, session.id));
          cleaned++;
          logger.info("Marked orphaned session as timeout", {
            sessionId: session.id,
            sandboxId: session.sandbox_id,
          });
        } catch (orphanError) {
          errors++;
          logger.error("Failed to mark orphaned session", {
            sessionId: session.id,
            error: orphanError,
          });
        }
      }
    }

    return { cleaned, errors };
  } catch (error) {
    logger.error("Sandbox cleanup job failed", { error });
    throw error;
  }
}
