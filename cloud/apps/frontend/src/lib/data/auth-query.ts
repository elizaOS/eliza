import { useSessionAuth } from "@/lib/hooks/use-session-auth";

export interface AuthenticatedQueryGate {
  enabled: boolean;
  userId: string | null;
}

function getSessionUserId(user: ReturnType<typeof useSessionAuth>["user"]): string | null {
  if (!user || typeof user !== "object" || !("id" in user)) return null;
  return typeof user.id === "string" ? user.id : null;
}

export function useAuthenticatedQueryGate(enabled = true): AuthenticatedQueryGate {
  const session = useSessionAuth();
  return {
    enabled: enabled && session.ready && session.authenticated,
    userId: getSessionUserId(session.user),
  };
}

export function authenticatedQueryKey(
  parts: readonly unknown[],
  gate: AuthenticatedQueryGate,
): readonly unknown[] {
  return [...parts, "auth", gate.userId];
}
