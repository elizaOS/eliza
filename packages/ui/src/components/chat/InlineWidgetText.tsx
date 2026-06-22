// Renders assistant message text with its inline widgets (#8876, #8997).
//
// Surfaces that show raw `message.content` (e.g. the continuous-chat overlay)
// would otherwise leak the agent's inline-widget markers — `[TASK:…]`,
// `[CHOICE:…]`, `[FORM]…[/FORM]`, `[FOLLOWUPS]…[/FOLLOWUPS]` — as literal text.
// This component segments the content with the SAME inline-widget registry the
// full MessageContent surface uses, rendering the prose plus the real widgets
// (task card / choice buttons / inline form / suggestion chips). Handlers are
// sourced from the app + composer contexts, so callers just render
// `<InlineWidgetText content={msg.content} />`.

import { type ReactNode, useMemo } from "react";
import { useAppSelectorShallow } from "../../state";
import { useChatComposer } from "../../state/ChatComposerContext.hooks";
import type { FormResultValue } from "./widgets/form-request";
// Side effect: register the built-in inline widgets (choice/followups/form/task).
import "./widgets/inline-builtins";
import {
  getInlineWidget,
  getInlineWidgets,
  type InlineWidgetContext,
} from "./widgets/inline-registry";

interface WidgetRegion {
  start: number;
  end: number;
  widgetKind: string;
  data: unknown;
}

/** Collect non-overlapping inline-widget regions in `content`, left to right. */
function collectWidgetRegions(content: string): WidgetRegion[] {
  const regions: WidgetRegion[] = [];
  for (const widget of getInlineWidgets()) {
    for (const match of widget.parse(content)) {
      regions.push({
        start: match.start,
        end: match.end,
        widgetKind: widget.kind,
        data: match.data,
      });
    }
  }
  regions.sort((a, b) => a.start - b.start);
  // Drop any region that overlaps one already accepted (first match wins).
  const accepted: WidgetRegion[] = [];
  let lastEnd = -1;
  for (const region of regions) {
    if (region.start >= lastEnd) {
      accepted.push(region);
      lastEnd = region.end;
    }
  }
  return accepted;
}

export function InlineWidgetText({ content }: { content: string }): ReactNode {
  const { sendActionMessage } = useAppSelectorShallow((s) => ({
    sendActionMessage: s.sendActionMessage,
  }));
  // Outside a chat provider this returns an inert setter, so prefill simply
  // no-ops rather than throwing — safe on every surface.
  const { setChatInput } = useChatComposer();

  const ctx = useMemo<InlineWidgetContext>(
    () => ({
      sendAction: (value: string) => {
        void sendActionMessage(value);
      },
      navigate: (payload: string) => {
        if (typeof window === "undefined") return;
        const detail = payload.startsWith("/")
          ? { viewPath: payload }
          : { viewId: payload };
        window.dispatchEvent(
          new CustomEvent("eliza:navigate:view", { detail }),
        );
      },
      prefillComposer: (payload: string) => {
        setChatInput(payload);
      },
      submitForm: (formId: string, values: Record<string, FormResultValue>) => {
        void sendActionMessage(
          `[form:submit ${formId}] ${JSON.stringify(values)}`,
        );
      },
    }),
    [sendActionMessage, setChatInput],
  );

  const regions = useMemo(() => collectWidgetRegions(content), [content]);

  // Fast path: no inline widgets — render the text exactly as before.
  if (regions.length === 0) {
    return content;
  }

  const nodes: ReactNode[] = [];
  let cursor = 0;
  regions.forEach((region, i) => {
    if (region.start > cursor) {
      const text = content.slice(cursor, region.start);
      if (text) nodes.push(<span key={`t-${cursor}`}>{text}</span>);
    }
    const widget = getInlineWidget(region.widgetKind);
    if (widget) {
      nodes.push(widget.render(region.data, ctx, `w-${i}`));
    }
    cursor = region.end;
  });
  if (cursor < content.length) {
    const tail = content.slice(cursor);
    if (tail) nodes.push(<span key={`t-${cursor}`}>{tail}</span>);
  }
  return <>{nodes}</>;
}
