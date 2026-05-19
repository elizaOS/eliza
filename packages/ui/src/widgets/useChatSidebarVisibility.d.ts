/**
 * React hook over the chat-sidebar widget visibility overrides.
 *
 * - Reads the persisted state from localStorage on mount.
 * - Subscribes to cross-window `storage` events so two tabs stay in sync.
 * - Persists every mutation immediately and bumps internal state.
 */
import { type VisibilityCandidate } from "./visibility";
export interface ChatSidebarVisibilityHook {
    overrides: Record<string, boolean>;
    isVisible(candidate: VisibilityCandidate): boolean;
    setVisible(candidate: VisibilityCandidate, next: boolean): void;
    reset(): void;
}
export declare function useChatSidebarVisibility(): ChatSidebarVisibilityHook;
//# sourceMappingURL=useChatSidebarVisibility.d.ts.map