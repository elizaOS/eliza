/**
 * Live hash/deep-link consumer for structural OS intents. It decodes the
 * app-shell's durable hash handoff, routes through the shared controller owner,
 * and clears launch parameters only after the owner has handled the outcome.
 */
import * as React from "react";
import { decodeOsIntentFromHash } from "../../../os-intent/host";
import { clearAssistantLaunchPayloadFromHash } from "../../../platform/assistant-launch-payload";
import type { ShellControllerSync } from "./useShellControllerSync";

export function useOsIntentRouting(sync: ShellControllerSync): void {
  const processingRef = React.useRef(new Set<string>());

  React.useEffect(() => {
    if (typeof window === "undefined") return;
    let active = true;
    const consume = (): void => {
      const hash = window.location.hash;
      const decoded = decodeOsIntentFromHash(hash);
      if (!decoded.ok || processingRef.current.has(decoded.intent.intentId)) {
        return;
      }
      processingRef.current.add(decoded.intent.intentId);
      void sync
        .dispatch({
          kind: "routeOsIntent",
          intent: decoded.intent,
          deliveryPolicy:
            decoded.intent.type === "send" ? "review-send" : "execute",
        })
        .then(() => {
          if (active) clearAssistantLaunchPayloadFromHash();
        })
        .catch((error: unknown) =>
          sync.reportError("OS intent dispatch failed", error),
        )
        .finally(() => processingRef.current.delete(decoded.intent.intentId));
    };
    consume();
    window.addEventListener("hashchange", consume);
    return () => {
      active = false;
      window.removeEventListener("hashchange", consume);
    };
  }, [sync.dispatch, sync.reportError]);
}
