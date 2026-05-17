/**
 * Wallet consent dialog formatters.
 *
 * Read-only helpers used by `BrowserWorkspaceView`'s wallet host bridge
 * to build the consent modal body. Inputs come straight from the dApp via
 * EIP-1193 — these helpers just format for display, never interpret or
 * mutate. Pulled out of the React component file so they're unit-testable
 * without standing up a renderer.
 */
export declare function formatAddressForDisplay(address: string): string;
export declare function formatWeiForDisplay(weiDecimalString: string): string;
/**
 * EIP-191 / personal_sign callers pass either a UTF-8 string or a
 * 0x-prefixed hex string of the bytes to sign. Show the decoded UTF-8
 * when possible so the user sees the actual prompt rather than hex.
 */
export declare function decodeSignableMessage(message: string): string;
export declare function decodeBase64ForPreview(base64: string): string;
export declare function truncateMessageForDisplay(message: string, max?: number): string;
//# sourceMappingURL=browser-wallet-consent-format.d.ts.map