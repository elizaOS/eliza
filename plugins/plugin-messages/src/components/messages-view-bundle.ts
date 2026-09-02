/**
 * Vite view-bundle entry: exposes the framed page plus the `interact` handler
 * under the names read from the built bundle. This host-facing `MessagesView`
 * matches the `/ui` and signed-registration ABI, while MessagesView.tsx remains
 * the raw Fast-Refresh-compatible component.
 */

export { MessagesPage as MessagesView } from "./MessagesPage.tsx";
export { interact } from "./messages-interact.ts";
