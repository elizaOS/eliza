import { and, eq, gte, or, sql } from "drizzle-orm";
import { dbRead, dbWrite } from "@/db/client";
import { organizations } from "@/db/schemas/organizations";
import { users } from "@/db/schemas/users";
import { logger } from "@/lib/utils/logger";

const DISPOSABLE_EMAIL_DOMAINS = new Set([
  "tempmail.com",
  "throwaway.email",
  "guerrillamail.com",
  "10minutemail.com",
  "mailinator.com",
  "temp-mail.org",
  "fakeinbox.com",
  "trashmail.com",
  "getnada.com",
  "mohmal.com",
  "tempail.com",
  "dispostable.com",
  "maildrop.cc",
  "sharklasers.com",
  "yopmail.com",
]);

const MAX_SIGNUPS_PER_IP_24H = 3;
const MAX_SIGNUPS_PER_FINGERPRINT_24H = 2;

export interface AbuseCheckResult {
  allowed: boolean;
  reason?: string;
  riskScore: number;
  flags: string[];
}

export interface SignupContext {
  email?: string;
  ipAddress?: string;
  fingerprint?: string;
  userAgent?: string;
}

class AbuseDetectionService {
  async checkSignupAbuse(context: SignupContext): Promise<AbuseCheckResult> {
    const flags: string[] = [];
    let riskScore = 0;

    try {
      if (context.email) {
        const emailCheck = await this.checkEmailAbuse(context.email);
        if (emailCheck.flags.length > 0) {
          flags.push(...emailCheck.flags);
          riskScore += emailCheck.riskScore;
        }
      }

      if (context.ipAddress) {
        const ipCheck = await this.checkIpAbuse(context.ipAddress);
        if (ipCheck.flags.length > 0) {
          flags.push(...ipCheck.flags);
          riskScore += ipCheck.riskScore;
        }
      }

      if (context.fingerprint) {
        const fpCheck = await this.checkFingerprintAbuse(context.fingerprint);
        if (fpCheck.flags.length > 0) {
          flags.push(...fpCheck.flags);
          riskScore += fpCheck.riskScore;
        }
      }

      const allowed = riskScore < 100;

      if (!allowed) {
        logger.warn("[AbuseDetection] Signup blocked", {
          context: {
            email: context.email ? `${context.email.slice(0, 3)}***` : undefined,
            ipAddress: context.ipAddress,
            hasFingerprint: !!context.fingerprint,
          },
          riskScore,
          flags,
        });
      }

      return {
        allowed,
        reason: allowed ? undefined : `Suspicious activity detected: ${flags.join(", ")}`,
        riskScore,
        flags,
      };
    } catch (error) {
      logger.error("[AbuseDetection] Error checking signup abuse:", error);

      // SECURITY FIX: Fail closed instead of open
      // When abuse detection fails, we should be cautious and flag the attempt
      // This prevents attackers from exploiting error conditions to bypass checks
      return {
        allowed: false,
        reason: "Abuse check temporarily unavailable. Please try again.",
        riskScore: 100,
        flags: ["abuse_check_error"],
      };
    }
  }

  private async checkEmailAbuse(email: string): Promise<{ flags: string[]; riskScore: number }> {
    const flags: string[] = [];
    let riskScore = 0;

    const domain = email.split("@")[1]?.toLowerCase();
    if (domain && DISPOSABLE_EMAIL_DOMAINS.has(domain)) {
      flags.push("disposable_email");
      riskScore += 80;
    }

    if (email.match(/\+.*@/)) {
      flags.push("email_alias");
      riskScore += 10;
    }

    const [existingUser] = await dbRead
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email.toLowerCase()))
      .limit(1);

    if (existingUser) {
      flags.push("email_already_registered");
      riskScore += 100;
    }

    return { flags, riskScore };
  }

  private async checkIpAbuse(ipAddress: string): Promise<{ flags: string[]; riskScore: number }> {
    const flags: string[] = [];
    let riskScore = 0;

    const twentyFourHoursAgo = new Date();
    twentyFourHoursAgo.setHours(twentyFourHoursAgo.getHours() - 24);

    const [recentSignups] = await dbRead
      .select({
        count: sql<number>`COUNT(*)::int`,
      })
      .from(organizations)
      .where(
        and(
          sql`${organizations.settings}->>'signup_ip' = ${ipAddress}`,
          gte(organizations.created_at, twentyFourHoursAgo),
        ),
      );

    const signupCount = recentSignups?.count || 0;

    if (signupCount >= MAX_SIGNUPS_PER_IP_24H) {
      flags.push("ip_rate_limit_exceeded");
      riskScore += 60;
    } else if (signupCount >= MAX_SIGNUPS_PER_IP_24H - 1) {
      flags.push("ip_rate_limit_warning");
      riskScore += 30;
    }

    return { flags, riskScore };
  }

  private async checkFingerprintAbuse(
    fingerprint: string,
  ): Promise<{ flags: string[]; riskScore: number }> {
    const flags: string[] = [];
    let riskScore = 0;

    const twentyFourHoursAgo = new Date();
    twentyFourHoursAgo.setHours(twentyFourHoursAgo.getHours() - 24);

    const [recentSignups] = await dbRead
      .select({
        count: sql<number>`COUNT(*)::int`,
      })
      .from(organizations)
      .where(
        and(
          sql`${organizations.settings}->>'signup_fingerprint' = ${fingerprint}`,
          gte(organizations.created_at, twentyFourHoursAgo),
        ),
      );

    const signupCount = recentSignups?.count || 0;

    if (signupCount >= MAX_SIGNUPS_PER_FINGERPRINT_24H) {
      flags.push("fingerprint_rate_limit_exceeded");
      riskScore += 80;
    } else if (signupCount >= MAX_SIGNUPS_PER_FINGERPRINT_24H - 1) {
      flags.push("fingerprint_rate_limit_warning");
      riskScore += 40;
    }

    return { flags, riskScore };
  }

  async recordSignupMetadata(organizationId: string, context: SignupContext): Promise<void> {
    try {
      const [org] = await dbRead
        .select({ settings: organizations.settings })
        .from(organizations)
        .where(eq(organizations.id, organizationId))
        .limit(1);

      const currentSettings = (org?.settings || {}) as Record<string, unknown>;

      const updatedSettings = {
        ...currentSettings,
        signup_ip: context.ipAddress,
        signup_fingerprint: context.fingerprint,
        signup_user_agent: context.userAgent,
        signup_timestamp: new Date().toISOString(),
      };

      await dbWrite
        .update(organizations)
        .set({ settings: updatedSettings })
        .where(eq(organizations.id, organizationId));

      logger.debug("[AbuseDetection] Recorded signup metadata", {
        organizationId,
        hasIp: !!context.ipAddress,
        hasFingerprint: !!context.fingerprint,
      });
    } catch (error) {
      logger.error("[AbuseDetection] Error recording signup metadata:", error);
    }
  }

  async getSignupRiskReport(organizationId: string): Promise<{
    signupContext: SignupContext | null;
    relatedOrganizations: number;
  }> {
    try {
      const [org] = await dbRead
        .select({ settings: organizations.settings })
        .from(organizations)
        .where(eq(organizations.id, organizationId))
        .limit(1);

      const settings = (org?.settings || {}) as Record<string, unknown>;

      const signupContext: SignupContext = {
        ipAddress: settings.signup_ip as string | undefined,
        fingerprint: settings.signup_fingerprint as string | undefined,
        userAgent: settings.signup_user_agent as string | undefined,
      };

      let relatedOrganizations = 0;

      if (signupContext.ipAddress || signupContext.fingerprint) {
        const conditions = [];
        if (signupContext.ipAddress) {
          conditions.push(
            sql`${organizations.settings}->>'signup_ip' = ${signupContext.ipAddress}`,
          );
        }
        if (signupContext.fingerprint) {
          conditions.push(
            sql`${organizations.settings}->>'signup_fingerprint' = ${signupContext.fingerprint}`,
          );
        }

        const [result] = await dbRead
          .select({ count: sql<number>`COUNT(*)::int` })
          .from(organizations)
          .where(or(...conditions));

        relatedOrganizations = Math.max(0, (result?.count || 1) - 1);
      }

      return {
        signupContext,
        relatedOrganizations,
      };
    } catch (error) {
      logger.error("[AbuseDetection] Error getting risk report:", error);
      return {
        signupContext: null,
        relatedOrganizations: 0,
      };
    }
  }
}

export const abuseDetectionService = new AbuseDetectionService();
