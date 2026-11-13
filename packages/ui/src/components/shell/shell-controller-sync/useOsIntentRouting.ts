/**
 * Live hash/deep-link consumer for structural OS intents. It decodes the
 * app-shell's durable hash handoff, routes it through the shell controller, and
 * clears launch parameters only after the outcome has been handled.
 */
import type { OsIntent } from "@elizaos/contracts";
import * as React from "react";
import { logger } from "../../../logger";
import { clearAssistantLaunchPayloadFromHash } from "../../../platform/assistant-launch-payload";
import { decodeOsIntentFromHash } from "../../../platform/os-intent";

export function useOsIntentRouting(
  routeOsIntent: (intent: OsIntent) => Promise<void>,
): void {
  const processingRef = React.useRef(new Set<string>());

  React.useEffect(() => {
    if (typeof window === "undefined") return;
    let active = true;
    const consume = (event?: HashChangeEvent): void => {
      // Boot can enqueue several hash changes before the browser delivers them.
      const hash = event?.newURL
        ? new URL(event.newURL).hash
        : window.location.hash;
      const decoded = decodeOsIntentFromHash(hash);
      if (!decoded.ok || processingRef.current.has(decoded.intent.intentId)) {
        return;
      }
      processingRef.current.add(decoded.intent.intentId);
      void routeOsIntent(decoded.intent)
        .then(() => {
          if (active && window.location.hash === hash)
            clearAssistantLaunchPayloadFromHash();
        })
        .catch((error: unknown) =>
          logger.warn({ error }, "OS intent dispatch failed"),
        )
        .finally(() => processingRef.current.delete(decoded.intent.intentId));
    };
    consume();
    window.addEventListener("hashchange", consume);
    return () => {
      active = false;
      window.removeEventListener("hashchange", consume);
    };
  }, [routeOsIntent]);
}
