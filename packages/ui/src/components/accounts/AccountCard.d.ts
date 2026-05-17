/**
 * AccountCard — single account row inside an AccountList.
 *
 * Renders the credential's health glyph, label (inline-editable), source
 * badge, priority controls (up/down arrows — no drag-drop dependency),
 * usage bars (Anthropic shows session + weekly, Codex shows session
 * only), enabled toggle, Test/Refresh/Delete actions, and a confirm
 * dialog for delete.
 */
import type { AccountWithCredentialFlag } from "../../api/client-agent";
export interface AccountCardProps {
    account: AccountWithCredentialFlag;
    isFirst: boolean;
    isLast: boolean;
    saving: boolean;
    onPatch: (body: Partial<{
        label: string;
        enabled: boolean;
        priority: number;
    }>) => Promise<void>;
    onMoveUp: () => Promise<void>;
    onMoveDown: () => Promise<void>;
    onTest: () => Promise<void>;
    onRefreshUsage: () => Promise<void>;
    onDelete: () => Promise<void>;
    testBusy?: boolean;
    refreshBusy?: boolean;
}
export declare function AccountCard({ account, isFirst, isLast, saving, onPatch, onMoveUp, onMoveDown, onTest, onRefreshUsage, onDelete, testBusy, refreshBusy, }: AccountCardProps): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=AccountCard.d.ts.map