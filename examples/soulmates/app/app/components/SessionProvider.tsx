"use client";

import { SessionProvider as NextAuthSessionProvider } from "next-auth/react";
import type { ReactNode } from "react";

type Props = {
  children: ReactNode;
  authEnabled: boolean;
};

export function SessionProvider({ children, authEnabled }: Props) {
  if (!authEnabled) {
    return <>{children}</>;
  }
  return <NextAuthSessionProvider>{children}</NextAuthSessionProvider>;
}
