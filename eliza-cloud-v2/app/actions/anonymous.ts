"use server";

import { getOrCreateAnonymousUser } from "@/lib/auth-anonymous";
import { cookies } from "next/headers";

const ANON_SESSION_COOKIE = "eliza-anon-session";

/**
 * Gets or creates an anonymous user session.
 * Sets an HTTP-only cookie if a new session is created.
 *
 * @returns The anonymous user result with session token and expiration if new.
 */
export async function getOrCreateAnonymousUserAction() {
  const result = await getOrCreateAnonymousUser();

  // Set cookie if this is a new session
  if (result.isNew && "sessionToken" in result && "expiresAt" in result) {
    const cookieStore = await cookies();
    cookieStore.set(ANON_SESSION_COOKIE, result.sessionToken as string, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      expires: result.expiresAt as Date,
      path: "/",
    });
  }

  return result;
}
