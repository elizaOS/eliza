import { readEnv } from "@/lib/env";

export const DEV_SESSION_COOKIE = "soulmates-dev-session";

export function isAuthEnabled(): boolean {
  return readEnv("NEXTAUTH_SECRET") !== null;
}
