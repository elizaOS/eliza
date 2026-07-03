/**
 * The single source of truth for how an inline chat-reply widget drives the
 * chat surface. Both message surfaces, the full `MessageContent` (ChatView)
 * and the lightweight `InlineWidgetText` (ContinuousChatOverlay), build their
 * `InlineWidgetContext` from THIS hook, so a CHOICE pick, a FOLLOWUPS chip, and
 * a FORM submit behave identically no matter where the reply is rendered.
 *
 * The two surfaces previously each defined these four handlers inline, byte for
 * byte the same. Two copies of one contract is a drift hazard (the issue's #1
 * surface-parity risk, #9304), unify them here.
 *
 * Callers pass the already-subscribed store setters rather than re-subscribing,
 * because `MessageContent` reads `sendActionMessage`/`setChatInput` for other
 * purposes too; the handler *logic* is what must stay single-sourced.
 */

import { useMemo } from "react";
import { dispatchNavigateViewEvent } from "../../../events";
import type { FormResultValue } from "./form-request";
import type { InlineWidgetContext } from "./inline-registry";

export function useInlineWidgetContext(
  sendActionMessage: (text: string) => Promise<void>,
  setChatInput: (text: string) => void,
): InlineWidgetContext {
  return useMemo<InlineWidgetContext>(
    () => ({
      // A choice pick / default followup: send the value back through the
      // action-message pipeline.
      sendAction: (value: string) => {
        void sendActionMessage(value);
      },
      // A followup `navigate` chip: deliver the passive view-switch SUGGESTION
      // as the same `eliza:navigate:view` event the VIEWS action uses. A
      // `/`-prefixed payload is a viewPath; anything else is a viewId.
      navigate: (payload: string) => {
        if (typeof window === "undefined") return;
        const detail = payload.startsWith("/")
          ? { viewPath: payload }
          : { viewId: payload };
        dispatchNavigateViewEvent(detail);
      },
      // A followup `prompt` chip: prefill the composer draft. Outside a chat
      // provider `setChatInput` is an inert setter, so this safely no-ops.
      prefillComposer: (payload: string) => {
        setChatInput(payload);
      },
      // A structured in-chat form submit: send the result back through the same
      // action-message pipeline.
      submitForm: (formId: string, values: Record<string, FormResultValue>) => {
        void sendActionMessage(
          `[form:submit ${formId}] ${JSON.stringify(values)}`,
        );
      },
    }),
    [sendActionMessage, setChatInput],
  );
}
