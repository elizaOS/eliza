/**
 * Vite view-bundle entry: exposes the embeddable view plus the `interact`
 * handler under the names read from the built bundle. The remote-view host owns
 * page chrome; signed native registration continues to mount `MessagesPage`.
 */

export { MessagesView } from "./MessagesView.tsx";
export { interact } from "./messages-interact.ts";
