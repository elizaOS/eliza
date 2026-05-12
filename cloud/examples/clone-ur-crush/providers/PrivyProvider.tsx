"use client";

import { PrivyProvider as PrivyProviderReactAuth } from "@privy-io/react-auth";

export function PrivyProvider({ children }: { children: React.ReactNode }) {
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID;

  if (!appId) {
    console.warn("NEXT_PUBLIC_PRIVY_APP_ID is not set. Authentication will not work.");
    return <>{children}</>;
  }

  return (
    <PrivyProviderReactAuth
      appId={appId}
      config={{
        loginMethods: ["google", "tiktok", "twitter", "discord", "email"],
        appearance: {
          theme: "light",
          accentColor: "#ff4081",
          logo: "/logo.png",
        },
        embeddedWallets: {
          createOnLogin: "off",
        },
      }}
    >
      {children}
    </PrivyProviderReactAuth>
  );
}
