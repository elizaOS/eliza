import type { PrivyClientConfig } from "@privy-io/react-auth";

import { CHAIN } from "../constants/chains";

type Appearance = Omit<
  NonNullable<PrivyClientConfig["appearance"]>,
  "theme"
> & {
  theme?: "light" | "dark" | `#${string}` | "system";
};

type PolyagentPrivyConfig = Omit<
  PrivyClientConfig,
  "appearance" | "embeddedWallets"
> & {
  appearance?: Appearance;
  embeddedWallets?: {
    ethereum?: {
      createOnLogin?: "all-users" | "users-without-wallets" | "off";
    };
  };
};

const appearance: Appearance = {
  theme: "system",
  accentColor: "#0066FF",
  logo: "/assets/logos/logo.svg",
};

const loginMethodsAndOrder: NonNullable<
  PolyagentPrivyConfig["loginMethodsAndOrder"]
> = {
  primary: ["email"],
  overflow: [
    "metamask",
    "twitter",
    "discord",
    "coinbase_wallet",
    "rainbow",
    "rabby_wallet",
  ],
};

const embeddedWallets: NonNullable<PolyagentPrivyConfig["embeddedWallets"]> = {
  ethereum: { createOnLogin: "users-without-wallets" },
};

export const privyConfig: { appId: string; config: PolyagentPrivyConfig } = {
  appId: process.env.NEXT_PUBLIC_PRIVY_APP_ID || "",
  config: {
    appearance,
    loginMethodsAndOrder,
    embeddedWallets,
    defaultChain: CHAIN,
    supportedChains: [CHAIN],
  },
};
