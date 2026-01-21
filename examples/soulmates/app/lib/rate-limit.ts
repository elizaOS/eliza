import { eq, lt } from "drizzle-orm";
import { getDatabase, rateLimitTable } from "@/lib/db";
import { logger } from "@/lib/logger";

export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  resetInSeconds: number;
};

export async function checkRateLimit(
  key: string,
  maxRequests: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  const db = await getDatabase();
  const now = new Date();
  const resetAt = new Date(now.getTime() + windowSeconds * 1000);

  if (Math.random() < 0.01) {
    await db
      .delete(rateLimitTable)
      .where(lt(rateLimitTable.resetAt, new Date()))
      .catch((err) => {
        logger.warn("Rate limit cleanup failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }

  const [entry] = await db
    .select()
    .from(rateLimitTable)
    .where(eq(rateLimitTable.key, key))
    .limit(1);

  if (!entry || entry.resetAt < now) {
    await db
      .insert(rateLimitTable)
      .values({ key, count: 1, resetAt })
      .onConflictDoUpdate({
        target: rateLimitTable.key,
        set: { count: 1, resetAt },
      });
    return {
      allowed: true,
      remaining: maxRequests - 1,
      resetInSeconds: windowSeconds,
    };
  }

  const resetInSeconds = Math.ceil(
    (entry.resetAt.getTime() - now.getTime()) / 1000,
  );

  if (entry.count >= maxRequests) {
    return { allowed: false, remaining: 0, resetInSeconds };
  }

  await db
    .update(rateLimitTable)
    .set({ count: entry.count + 1 })
    .where(eq(rateLimitTable.key, key));
  return {
    allowed: true,
    remaining: maxRequests - entry.count - 1,
    resetInSeconds,
  };
}

export const checkSmsRateLimit = (ip: string) =>
  checkRateLimit(`sms:ip:${ip}`, 5, 60);
export const checkPhoneRateLimit = (phone: string) =>
  checkRateLimit(`sms:phone:${phone}`, 3, 60);
export const checkLoginRateLimit = (ip: string) =>
  checkRateLimit(`login:ip:${ip}`, 10, 300);
