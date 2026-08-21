/**
 * Renders assistant prose and inline widgets in the shell transcript. It uses
 * the canonical message segment parser so hidden markers and structured
 * affordances stay consistent with the full chat view.
 */

import { stripUnclaimedInteractionMarkup } from "@elizaos/core";
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
import { SafeMarkdownText } from "./SafeMarkdownText";
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
  const segments = useParsedSegments(
    stripUnclaimedInteractionMarkup(content),
    false,
  );

  // Fast path: a single plain-text segment (most replies) renders as-is.
  if (segments.length === 1 && segments[0].kind === "text") {
    return <SafeMarkdownText text={segments[0].text} />;
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
        if (seg.text) {
          nodes.push(
            <span key={nextKey("t")}>
              <SafeMarkdownText text={seg.text} />
            </span>,
          );
        }
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
