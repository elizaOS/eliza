/**
 * Optional Steward packages — ambient declarations so typecheck passes when
 * packages are not installed or publish incomplete `.d.ts` files.
 */
declare module "@stwd/react" {
  import type { ComponentType, FC, ReactNode } from "react";

  export const StewardProvider: ComponentType<{
    children: ReactNode;
    client?: unknown;
    agentId?: string;
    auth?: Record<string, unknown>;
    tenantId?: string;
    [key: string]: unknown;
  }>;

  export const StewardLogin: ComponentType<{
    onSuccess?: (result: { token: string; user?: unknown }) => void | Promise<void>;
    onError?: (error: Error) => void;
    showPasskey?: boolean;
    showEmail?: boolean;
    showSIWE?: boolean;
    showGoogle?: boolean;
    showDiscord?: boolean;
    variant?: "card" | "inline";
    logo?: ReactNode;
    title?: string;
    subtitle?: string;
    tenantId?: string;
    className?: string;
  }>;

  export function useAuth(): {
    isAuthenticated: boolean;
    isLoading: boolean;
    user: { id?: string; email?: string; walletAddress?: string } | null;
    session?: unknown;
    signOut: () => void | Promise<void>;
    getToken: () => string | null;
    getAccessToken?: () => Promise<string | null>;
  };
}

declare module "@stwd/react/wallet" {
  import type { CSSProperties, FC, ReactNode } from "react";

  export type WalletChains = "both" | "evm" | "solana";

  export const WalletLogin: FC<{
    chains?: WalletChains | null;
    onSuccess?: (result: { token: string }) => void;
    onError?: (walletError: { message?: string }) => void;
    evmLabel?: string;
    solanaLabel?: string;
    className?: string;
    style?: CSSProperties;
  }>;
  export const StewardWalletProvider: FC<{ children: ReactNode }>;
  export function useStewardWallet(): Record<string, unknown>;
}

declare module "@stwd/sdk" {
  export class StewardApiError extends Error {
    status?: number;
    constructor(message?: string, init?: { status?: number });
  }

  export type StewardUser = {
    id: string;
    email: string;
    walletAddress?: string;
    walletChain?: "ethereum" | "solana";
  };

  export type StewardAuthResult = {
    token: string;
    refreshToken: string;
    expiresIn: number;
    user: StewardUser;
  };

  export type StewardAgentResponse = {
    id: string;
    name: string;
    walletAddress?: string | null;
    walletAddresses?: {
      evm?: string | null;
      solana?: string | null;
    };
    createdAt?: Date;
  };

  export class StewardAuth {
    constructor(options: Record<string, unknown>);
    getSession(): { token?: string } | null;
    refreshSession(): Promise<{ token?: string } | null>;
    signInWithPasskey(email: string): Promise<StewardAuthResult>;
    signInWithEmail(email: string): Promise<void>;
    signInWithSIWE(
      address: string,
      signMessage: (message: string) => Promise<string>,
    ): Promise<StewardAuthResult>;
    signInWithSolana(
      publicKey: string,
      signMessage: (message: Uint8Array) => Promise<Uint8Array>,
    ): Promise<StewardAuthResult>;
    getProviders(): Promise<Record<string, boolean>>;
  }

  export type StewardBalanceResponse = {
    balances?: {
      native?: string;
      nativeFormatted?: string | null;
      chainId?: number | string | null;
      symbol?: string | null;
    };
  };

  export type PolicyType =
    | "spending-limit"
    | "approved-addresses"
    | "auto-approve-threshold"
    | "time-window"
    | "rate-limit"
    | "allowed-chains"
    | "reputation-threshold"
    | "reputation-scaling";

  export type PolicyRule = {
    id: string;
    type: PolicyType;
    enabled: boolean;
    config: Record<string, unknown>;
    description?: string;
  };

  export type StewardAddressResponse = {
    addresses: Array<{ chainFamily: string; address: string }>;
  };

  export type StewardTransactionRecord = {
    id: string;
    status: string;
    createdAt?: Date | number | string | null;
    txHash?: string;
    request?: unknown;
  };

  export type StewardAgentDashboardResponse = {
    recentTransactions?: StewardTransactionRecord[];
  };

  export type StewardApprovalRecord = {
    agentId?: string;
  } & Record<string, unknown>;

  export class StewardClient {
    constructor(options: Record<string, unknown>);
    createWallet(
      agentName: string,
      displayName: string,
      clientAddress: string,
    ): Promise<StewardAgentResponse>;
    getAgent(idOrName: string): Promise<StewardAgentResponse>;
    getAddresses(agentId: string): Promise<StewardAddressResponse>;
    getBalance(agentId: string): Promise<StewardBalanceResponse>;
    getPolicies(agentId: string): Promise<PolicyRule[]>;
    setPolicies(agentId: string, policies: PolicyRule[]): Promise<void>;
    getAgentDashboard(agentId: string): Promise<StewardAgentDashboardResponse>;
    listApprovals(opts?: {
      status?: string;
      limit?: number;
      offset?: number;
    }): Promise<StewardApprovalRecord[]>;
    approveTransaction(
      txId: string,
      opts?: { comment?: string; approvedBy?: string },
    ): Promise<unknown>;
    denyTransaction(txId: string, reason: string, deniedBy?: string): Promise<unknown>;
    signTransaction(agentId: string, tx: Record<string, unknown>): Promise<unknown>;
    signMessage(agentId: string, message: string): Promise<unknown>;
    signTypedData(agentId: string, payload: Record<string, unknown>): Promise<unknown>;
  }
}
