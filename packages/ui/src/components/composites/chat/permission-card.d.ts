import { type IPermissionsRegistry, type PermissionId, type PermissionState } from "@elizaos/shared";
import type * as React from "react";
/**
 * Friendly human-readable labels per permission id. Used as the card title
 * (e.g. `reminders` → "Apple Reminders").
 */
export declare const PERMISSION_LABELS: Record<PermissionId, string>;
export declare function getPermissionLabel(id: PermissionId): string;
/**
 * Result emitted to the agent when the user picks the fallback option. The
 * chat host turns this into a system-tagged user message:
 *   `__permission_card__:use_fallback feature=<feature>`
 *
 * The agent's lifeops fallback flow already recognises this prefix; see the
 * `system-prompt-action-block.md` doc and the lifeops permission router. We
 * chose a system-tagged message (vs a custom WS event) so it goes through
 * the existing planner pipeline and lands in the trajectory log without any
 * out-of-band wiring.
 */
export interface PermissionCardFallbackChoice {
    type: "use_fallback";
    feature: string;
    permission: PermissionId;
}
export interface PermissionCardLabels {
    grantAccess?: string;
    openSettings?: string;
    notNow?: string;
    comingSoon?: string;
    unavailable?: string;
    granted?: string;
    granting?: string;
}
export interface PermissionCardProps {
    permission: PermissionId;
    reason: string;
    feature: string;
    fallbackOffered?: boolean;
    fallbackLabel?: string;
    /**
     * Permissions registry. When omitted, the card falls back to a passive
     * `not-determined` rendering so it still renders in stories/tests without
     * a wired runtime.
     */
    registry?: IPermissionsRegistry;
    /** Initial state override for tests / SSR. */
    initialState?: PermissionState;
    /** Called when the user dismisses the card. */
    onDismiss?: () => void;
    /** Called when the user picks the fallback option. */
    onFallback?: (choice: PermissionCardFallbackChoice) => void;
    /** Called once the registry reports `granted`. The agent uses this to
     *  retry the original action. */
    onGranted?: (state: PermissionState) => void;
    /** Opens OS settings for denied permissions that cannot be requested again. */
    onOpenSettings?: (permission: PermissionId) => void | Promise<void>;
    labels?: PermissionCardLabels;
    className?: string;
}
export declare function PermissionCard({ permission, reason, feature, fallbackOffered, fallbackLabel, registry, initialState, onDismiss, onFallback, onGranted, onOpenSettings, labels, className, }: PermissionCardProps): React.ReactElement | null;
export interface PermissionClientLike {
    getPermission(id: PermissionId): Promise<PermissionState>;
    requestPermission(id: PermissionId): Promise<PermissionState>;
}
export declare function createClientPermissionsRegistry(clientLike: PermissionClientLike): IPermissionsRegistry;
/**
 * Render-helper invoked by the chat transcript's `renderMessageContent` hook
 * when the message text contains a parsed permission_request block. The host
 * passes the parsed payload, the registry, and message-level callbacks.
 */
export interface PermissionCardPayload {
    permission: PermissionId;
    reason: string;
    feature: string;
    fallbackOffered?: boolean;
    fallbackLabel?: string;
}
/**
 * Minimal UI-side parser for `permission_request` action blocks. Mirrors the
 * server-side `parseActionBlock` output for `permission_request` so the
 * chat surface can render the inline card without pulling in `@elizaos/agent`.
 *
 * Returns `null` for any other action block (`respond`, `escalate`,
 * `ignore`, `complete`) so the caller can fall back to plain text rendering.
 */
export declare function parsePermissionRequestFromText(text: string): {
    display: string;
    payload: PermissionCardPayload;
} | null;
export declare function renderPermissionCardFromPayload(payload: PermissionCardPayload, opts?: Omit<PermissionCardProps, "permission" | "reason" | "feature" | "fallbackOffered" | "fallbackLabel"> & {
    key?: string;
}): React.ReactElement | null;
//# sourceMappingURL=permission-card.d.ts.map