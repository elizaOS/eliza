/**
 * AccountList — provider-scoped multi-account UI.
 *
 * Renders the rotation strategy picker, "Add account" button, and a
 * priority-ordered stack of `AccountCard`s for the given providerId.
 * Up/down reordering swaps priorities with the neighbour via two
 * sequential PATCH calls (no drag-drop dependency).
 */
import type { LinkedAccountProviderId } from "@elizaos/shared";
interface AccountListProps {
    providerId: LinkedAccountProviderId;
}
export declare function AccountList({ providerId }: AccountListProps): import("react/jsx-runtime").JSX.Element;
export {};
//# sourceMappingURL=AccountList.d.ts.map