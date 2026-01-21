import type { NextAuthOptions, Session } from "next-auth";
import NextAuth from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import { isDevLoginEnabled, readEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import { normalizePhone } from "@/lib/phone";
import {
  getAdminPhones,
  getUserById,
  type UserRecord,
  upsertUserByPhone,
} from "@/lib/store";
import { checkSmsVerification } from "@/lib/twilio";

type SessionUser = NonNullable<Session["user"]>;

const DEV_PHONE = "+15555550100";

function getDevPhone(): string | null {
  const raw = readEnv("DEV_LOGIN_PHONE") ?? DEV_PHONE;
  return normalizePhone(raw);
}

export async function getDevLoginUser(): Promise<UserRecord | null> {
  logger.info("getDevLoginUser called", {
    devLoginEnabled: isDevLoginEnabled(),
  });
  if (!isDevLoginEnabled()) {
    logger.warn("Dev login not enabled");
    return null;
  }
  const phone = getDevPhone();
  logger.info("Dev phone", { phone });
  if (!phone) {
    logger.warn("Dev phone normalization failed");
    return null;
  }

  try {
    const forceAdmin = process.env.NODE_ENV !== "production";
    const user = await upsertUserByPhone(phone, {
      status: "active",
      isAdmin: forceAdmin || getAdminPhones().includes(phone),
    });
    logger.info("Dev user created/fetched", {
      userId: user.id,
      phone: user.phone,
    });
    return user;
  } catch (err) {
    logger.error("Failed to create dev user", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export const authOptions: NextAuthOptions = {
  providers: [
    CredentialsProvider({
      name: "SMS",
      credentials: {
        phone: { label: "Phone", type: "text" },
        code: { label: "Code", type: "text" },
        devLogin: { label: "Dev Login", type: "text" },
      },
      authorize: async (credentials) => {
        logger.info("authorize called", {
          devLogin: credentials?.devLogin,
          hasPhone: !!credentials?.phone,
        });
        if (credentials?.devLogin === "true") {
          const user = await getDevLoginUser();
          if (!user) {
            logger.error("Dev login: getDevLoginUser returned null");
          }
          return user
            ? { id: user.id, name: user.name, email: user.email }
            : null;
        }

        const phone = normalizePhone(credentials?.phone ?? "");
        const code = credentials?.code?.trim() ?? "";
        if (!phone || !code) return null;

        const verified = await checkSmsVerification(phone, code).catch(
          (err) => {
            logger.error("SMS verification failed", {
              phone,
              error: err instanceof Error ? err.message : String(err),
            });
            return false;
          },
        );
        if (!verified) return null;

        const user = await upsertUserByPhone(phone, {
          isAdmin: getAdminPhones().includes(phone),
        });
        logger.info("User authenticated", { userId: user.id, phone });
        return { id: user.id, name: user.name, email: user.email };
      },
    }),
  ],
  session: { strategy: "jwt" },
  pages: { signIn: "/login" },
  callbacks: {
    async session({ session, token }) {
      const userId = token.sub;
      if (!userId) return session;

      const user = await getUserById(userId);
      if (!user) return session;

      const enriched: SessionUser = {
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        credits: user.credits,
        status: user.status,
        isAdmin: user.isAdmin,
        allowlisted: user.status === "active",
      };
      session.user = enriched;
      return session;
    },
  },
  secret: readEnv("NEXTAUTH_SECRET") ?? undefined,
};

export const authHandler = NextAuth(authOptions);
