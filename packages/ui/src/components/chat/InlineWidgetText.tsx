// Renders assistant message text with its inline widgets (#8876, #8997, #9304).
//
// The continuous-chat overlay shows raw `message.content`. Without segmentation
// it would leak, as literal text, every marker the full ChatView surface
// handles: the inline-widget markers (`[TASK:…]`, `[CHOICE:…]`, `[FORM]…[/FORM]`,
// `[FOLLOWUPS]…[/FOLLOWUPS]`), the structured markers (`[CONFIG:…]`, fenced
// UiSpec JSON, permission requests), and hidden reasoning/tool tags.
//
// To stay consistent with MessageContent (ChatView) and never drift, this
// delegates to the SAME `parseSegments` parser instead of re-implementing a
// partial one. It renders the prose, fenced code blocks, and the interactive
// inline widgets (task card / choice buttons / inline form / suggestion chips).
// The heavier full-surface affordances — plugin config card, UiSpec block,
// permission card — need the host client/registry that this lightweight
// pass-through surface intentionally does not carry, so they are omitted here;
// their raw markers are stripped (not leaked) and the full ChatView still
// renders them. Handlers come from the app + composer contexts, so callers just
// render `<InlineWidgetText content={msg.content} />`.

import { type ReactNode, useMemo } from "react";
import { useAppSelectorShallow } from "../../state";
import { useChatComposer } from "../../state/ChatComposerContext.hooks";
import { CodeBlock } from "../ui/code-block";
import { parseSegments, type Segment } from "./message-parser-helpers";
// Side effect: register the built-in inline widgets (choice/followups/form/task).
import "./widgets/inline-builtins";
import { getInlineWidget } from "./widgets/inline-registry";
import { useInlineWidgetContext } from "./widgets/use-inline-widget-context";

export function InlineWidgetText({ content }: { content: string }): ReactNode {
  const { sendActionMessage } = useAppSelectorShallow((s) => ({
    sendActionMessage: s.sendActionMessage,
  }));
  // Outside a chat provider this returns an inert setter, so prefill simply
  // no-ops rather than throwing — safe on every surface.
  const { setChatInput } = useChatComposer();

  // Same shared contract MessageContent (ChatView) uses, so interactive inline
  // widgets behave identically on both surfaces.
  const ctx = useInlineWidgetContext(sendActionMessage, setChatInput);

  // The overlay shows clean display text (no raw analysis view), so parse in
  // non-analysis mode — hidden reasoning/tool tags are stripped, not leaked.
  const segments = useMemo<Segment[]>(() => {
    try {
      return parseSegments(content, false);
    } catch {
      return [{ kind: "text", text: content }];
    }
  }, [content]);

  // Fast path: a single plain-text segment (most replies) renders as-is.
  if (segments.length === 1 && segments[0].kind === "text") {
    return segments[0].text;
  }

  const keyCounts = new Map<string, number>();
  const nextKey = (base: string): string => {
    const n = (keyCounts.get(base) ?? 0) + 1;
    keyCounts.set(base, n);
    return `${base}:${n}`;
  };

  const nodes: ReactNode[] = [];
  for (const seg of segments) {
    switch (seg.kind) {
      case "text": {
        if (seg.text) nodes.push(<span key={nextKey("t")}>{seg.text}</span>);
        break;
      }
      case "code": {
        nodes.push(
          // `pointer-events-auto` so the copy affordance stays clickable even
          // where the overlay peek sheet is pass-through by design (#8997).
          <div key={nextKey("code")} className="pointer-events-auto">
            <CodeBlock
              className="my-2"
              value={seg.code}
              wrap
              copyable
              data-testid="code-block"
              {...(seg.lang ? { "data-lang": seg.lang } : {})}
            />
          </div>,
        );
        break;
      }
      case "widget": {
        const widget = getInlineWidget(seg.widgetKind);
        if (widget) {
          const key = nextKey(`w-${seg.widgetKind}`);
          nodes.push(
            <div key={key} className="pointer-events-auto">
              {widget.render(seg.data, ctx, key)}
            </div>,
          );
        }
        break;
      }
      // config / ui-spec / permission / analysis-xml: full-surface-only
      // affordances handled by MessageContent. Omitted on this lightweight
      // overlay, but their raw markers are stripped (not leaked) by parseSegments.
      default:
        break;
    }
  }
  return <>{nodes}</>;
}
