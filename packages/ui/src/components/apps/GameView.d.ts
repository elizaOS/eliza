/**
 * Game View — embeds a running app's game client in an iframe.
 *
 * Features:
 * - Full-screen iframe for game client
 * - PostMessage auth for embedded app viewers
 * - Split-screen mode with agent logs panel
 * - Connection status indicator
 */
import { type AppSessionState } from "../../api";
import type { DesktopClickAuditItem } from "../../utils/desktop-workspace";
export declare function buildDisconnectedSessionState(
  session: AppSessionState | null,
): AppSessionState | null;
export declare const DESKTOP_GAME_CLICK_AUDIT: readonly DesktopClickAuditItem[];
export declare function DesktopGameWindowControls({
  gameWindowId,
}: {
  gameWindowId: string | null;
}): import("react/jsx-runtime").JSX.Element;
export declare function GameView(): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=GameView.d.ts.map
