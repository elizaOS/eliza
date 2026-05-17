export declare function openExternalUrl(url: string): Promise<void>;
export declare function closeExternalBrowser(): Promise<void>;
/**
 * Pre-open a blank window **synchronously** inside a user-gesture handler,
 * then navigate it after an async API call resolves with the real URL.
 * This avoids popup-blocker issues that occur when `window.open` is called
 * after an `await` (losing the user-gesture context).
 *
 * Usage:
 * ```ts
 * const win = preOpenWindow();
 * const { authUrl } = await client.startLogin();
 * navigatePreOpenedWindow(win, authUrl);
 * ```
 */
export declare function preOpenWindow(): Window | null;
/**
 * Navigate a pre-opened window to the real URL, or fall back to
 * `openExternalUrl` if the pre-open was blocked / we're on desktop.
 */
export declare function navigatePreOpenedWindow(
  popup: Window | null,
  url: string,
): void;
//# sourceMappingURL=openExternalUrl.d.ts.map
