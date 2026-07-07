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
// The heavier affordances — plugin config card, UiSpec block, permission card —
// reuse the same renderers as MessageContent. Handlers come from the app +
// composer contexts, so callers just render
// `<InlineWidgetText content={msg.content} />`.

import type { ReactNode } from "react";
import { useAppSelectorShallow } from "../../state";
import { useChatComposer } from "../../state/ChatComposerContext.hooks";
import { CodeBlock } from "../ui/code-block";
import {
  InlinePluginConfig,
  MessagePermissionCard,
  MessageUiSpecBlock,
} from "./MessageContent";
import {
  isSafeNormalizedPluginId,
  normalizePluginId,
} from "./message-parser-helpers";
import { useParsedSegments } from "./use-parsed-segments";
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
  // Incremental prefix-cached parse so a streaming overlay bubble re-parses only
  // its changed tail (#15280); byte-identical to parseSegments.
  const segments = useParsedSegments(content, false);

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
      case "config": {
        if (!isSafeNormalizedPluginId(normalizePluginId(seg.pluginId))) break;
        nodes.push(
          <div
            key={nextKey(`config-${seg.pluginId}`)}
            className="pointer-events-auto whitespace-normal text-txt [text-shadow:none]"
          >
            <InlinePluginConfig pluginId={seg.pluginId} />
          </div>,
        );
        break;
      }
      case "ui-spec": {
        nodes.push(
          <div
            key={nextKey("ui-spec")}
            className="pointer-events-auto whitespace-normal text-txt [text-shadow:none]"
          >
            <MessageUiSpecBlock spec={seg.spec} raw={seg.raw} />
          </div>,
        );
        break;
      }
      case "permission": {
        nodes.push(
          <div
            key={nextKey(`permission-${seg.payload.feature}`)}
            className="pointer-events-auto whitespace-normal text-txt [text-shadow:none]"
          >
            <MessagePermissionCard payload={seg.payload} />
          </div>,
        );
        break;
      }
      // analysis-xml only appears in analysis mode. The overlay parses in
      // display mode, so hidden reasoning/tool tags are stripped, not rendered.
      default:
        break;
    }
  }
  return <>{nodes}</>;
}
