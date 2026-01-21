import { cookies } from "next/headers";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { DEV_SESSION_COOKIE, isAuthEnabled } from "@/lib/auth-mode";
import { isDevLoginEnabled } from "@/lib/env";
import { getUserById, type UserRecord } from "@/lib/store";

export async function requireSessionUser(): Promise<UserRecord | null> {
  // Dev mode without NextAuth
  if (!isAuthEnabled()) {
    if (!isDevLoginEnabled()) return null;
    const userId = (await cookies()).get(DEV_SESSION_COOKIE)?.value;
    // FIXED: Use the actual user ID from cookie instead of always creating dev user
    return userId ? getUserById(userId) : null;
  }

  // Production mode with NextAuth
  const session = await getServerSession(authOptions);
  const userId = session?.user?.id;
  return userId ? getUserById(userId) : null;
}

export async function requireAdminUser(): Promise<UserRecord | null> {
  const user = await requireSessionUser();
  return user?.isAdmin ? user : null;
}
