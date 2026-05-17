/**
 * AddAccountDialog — modal that walks the user through adding a new
 * credential to a provider's account pool.
 *
 * Paths:
 *   - **OAuth** (subscription providers): start the server-side OAuth
 *     flow, open the auth URL in a real browser window via
 *     `preOpenWindow` + `navigatePreOpenedWindow` (preserves the user
 *     gesture so popup blockers don't fire), then subscribe to the
 *     SSE stream at `/api/accounts/:provider/oauth/status` for terminal
 *     state. On `success`, hand the new `LinkedAccountConfig` to the
 *     parent. On error / timeout / cancel, surface the message inline
 *     and let the user retry. If the dialog closes mid-flow we cancel
 *     the server-side listener so it doesn't leak.
 *   - **Coding-plan key**: simple label + key form for dedicated coding
 *     endpoints only. These credentials are not written to general API env vars.
 *   - **External CLI**: show the first-party CLI login instruction; no token import.
 *   - **Unavailable**: explain why the provider cannot be linked safely.
 *   - **API key**: simple label + key form, immediate POST.
 *
 * The dialog is provider-aware: subscription providers are intentionally
 * constrained to their first-party coding surfaces.
 */
import type { LinkedAccountConfig, LinkedAccountProviderId } from "@elizaos/shared";
interface AddAccountDialogProps {
    open: boolean;
    providerId: LinkedAccountProviderId;
    onClose: () => void;
    onCreated: (account: LinkedAccountConfig) => void;
}
export declare function AddAccountDialog({ open, providerId, onClose, onCreated, }: AddAccountDialogProps): import("react/jsx-runtime").JSX.Element;
export {};
//# sourceMappingURL=AddAccountDialog.d.ts.map