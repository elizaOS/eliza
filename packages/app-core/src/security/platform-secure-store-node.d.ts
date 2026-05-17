import type { PlatformSecureStore } from "./platform-secure-store";
/**
 * Node-side factory: macOS Keychain, Linux `secret-tool`, or unavailable placeholder.
 * Windows Credential Manager is not wired yet (`none`).
 */
export declare function createNodePlatformSecureStore(): PlatformSecureStore;
export declare function isNodePlatformSecureStoreDefaultAvailable(): boolean;
/**
 * Explicit override: `ELIZA_WALLET_OS_STORE=0|false|off|no` disables this path.
 * When unset, default on for supported local secure stores.
 */
export declare function isWalletOsStoreReadEnabled(): boolean;
//# sourceMappingURL=platform-secure-store-node.d.ts.map
