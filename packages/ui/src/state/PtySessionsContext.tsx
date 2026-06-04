/**
 * Compatibility re-export. The PTY sessions context object + `usePtySessions`
 * hook live in `./PtySessionsContext.hooks` so importers stay React Fast
 * Refresh-compatible. Kept so the `state` barrel resolves unchanged.
 */
export {
  PtySessionsCtx,
  type PtySessionsValue,
  usePtySessions,
} from "./PtySessionsContext.hooks";
