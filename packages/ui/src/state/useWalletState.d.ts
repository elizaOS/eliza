/**
 * Wallet / Inventory / Registry / Drop / Whitelist state — extracted from AppContext.
 *
 * Manages:
 * - Wallet addresses, config, balances, NFTs, export flow
 * - Inventory view preferences (sort, filter, chain toggles)
 * - ERC-8004 on-chain registry (register, sync, status)
 * - Drop / mint state and actions
 * - Whitelist status
 *
 * Cross-domain dependencies accepted as params:
 * - `setActionNotice` — from useLifecycleState, used by handleWalletApiKeySave
 * - `agentName`       — from agentStatus?.agentName, used by registry/mint
 * - `characterName`   — from characterDraft?.name, used by registry/mint
 * - `promptModal`     — from AppContext's usePrompt(), used by handleExportKeys
 * - `confirmAction`   — confirmDesktopAction utility, used by handleExportKeys
 */
import type { WalletAddresses, WalletBalancesResponse, WalletChainKind, WalletConfigStatus, WalletConfigUpdateRequest, WalletEntry, WalletNftsResponse, WalletPrimaryMap, WalletSource } from "@elizaos/shared";
import { type DropStatus, type MintResult, type RegistryStatus, type WalletExportResult, type WhitelistStatus } from "../api";
import type { PromptOptions } from "../components/ui/confirm-dialog";
import type { InventoryChainFilters } from "./types";
interface WalletStateParams {
    setActionNotice: (text: string, tone?: "info" | "success" | "error", ttlMs?: number, once?: boolean, busy?: boolean) => void;
    /** Prompt modal function from AppContext's usePrompt() instance */
    promptModal: (opts: PromptOptions) => Promise<string | null>;
    /** Current agent name (from agentStatus?.agentName) */
    agentName: string | undefined;
    /** Current character draft name (from characterDraft?.name) */
    characterName: string | undefined;
}
export declare function useWalletState({ setActionNotice, promptModal, agentName, characterName, }: WalletStateParams): {
    state: {
        browserEnabled: boolean;
        computerUseEnabled: boolean;
        walletEnabled: boolean;
        walletAddresses: WalletAddresses | null;
        walletConfig: WalletConfigStatus | null;
        walletBalances: WalletBalancesResponse | null;
        walletNfts: WalletNftsResponse | null;
        walletLoading: boolean;
        walletNftsLoading: boolean;
        inventoryView: "tokens" | "nfts";
        walletExportData: WalletExportResult | null;
        walletExportVisible: boolean;
        walletApiKeySaving: boolean;
        wallets: WalletEntry[];
        walletPrimary: WalletPrimaryMap | null;
        walletPrimaryRestarting: Partial<Record<WalletChainKind, boolean>>;
        walletPrimaryPending: Partial<Record<WalletChainKind, boolean>>;
        cloudRefreshing: boolean;
        inventorySort: "symbol" | "value" | "chain";
        inventorySortDirection: "asc" | "desc";
        inventoryChainFilters: InventoryChainFilters;
        walletError: string | null;
        registryStatus: RegistryStatus | null;
        registryLoading: boolean;
        registryRegistering: boolean;
        registryError: string | null;
        dropStatus: DropStatus | null;
        dropLoading: boolean;
        mintInProgress: boolean;
        mintResult: MintResult | null;
        mintError: string | null;
        mintShiny: boolean;
        whitelistStatus: WhitelistStatus | null;
        whitelistLoading: boolean;
    };
    setBrowserEnabled: (v: boolean) => void;
    setComputerUseEnabled: (v: boolean) => void;
    setWalletEnabled: (v: boolean) => void;
    setWalletAddresses: import("react").Dispatch<import("react").SetStateAction<WalletAddresses | null>>;
    setInventoryView: import("react").Dispatch<import("react").SetStateAction<"tokens" | "nfts">>;
    setInventorySort: import("react").Dispatch<import("react").SetStateAction<"symbol" | "value" | "chain">>;
    setInventorySortDirection: import("react").Dispatch<import("react").SetStateAction<"asc" | "desc">>;
    setInventoryChainFilters: import("react").Dispatch<import("react").SetStateAction<InventoryChainFilters>>;
    setWalletError: import("react").Dispatch<import("react").SetStateAction<string | null>>;
    setRegistryError: import("react").Dispatch<import("react").SetStateAction<string | null>>;
    setMintResult: import("react").Dispatch<import("react").SetStateAction<MintResult | null>>;
    setMintError: import("react").Dispatch<import("react").SetStateAction<string | null>>;
    loadWalletConfig: () => Promise<void>;
    loadBalances: () => Promise<void>;
    loadNfts: () => Promise<void>;
    handleWalletApiKeySave: (config: WalletConfigUpdateRequest) => Promise<boolean>;
    setWalletPrimary: (chain: WalletChainKind, source: WalletSource) => Promise<void>;
    setPrimary: (chain: WalletChainKind, source: WalletSource) => Promise<void>;
    refreshCloud: () => Promise<void>;
    refreshCloudWallets: () => Promise<void>;
    handleExportKeys: () => Promise<void>;
    loadRegistryStatus: () => Promise<void>;
    registerOnChain: () => Promise<void>;
    syncRegistryProfile: () => Promise<void>;
    loadDropStatus: () => Promise<void>;
    mintFromDrop: (shiny: boolean) => Promise<void>;
    loadWhitelistStatus: () => Promise<void>;
};
export {};
//# sourceMappingURL=useWalletState.d.ts.map