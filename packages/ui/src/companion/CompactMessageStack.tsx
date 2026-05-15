import { useCallback, useEffect, useRef, useState } from "react";

export type CompanionRole = "agent" | "user";

export interface CompanionMessage {
  id: string;
  role: CompanionRole;
  text: string;
}

export interface CompactMessageStackProps {
  messages: readonly CompanionMessage[];
  collapsedCount?: number;
  className?: string;
}

const DEFAULT_COLLAPSED = 3;

export function CompactMessageStack(
  props: CompactMessageStackProps,
): JSX.Element {
  const { messages, collapsedCount = DEFAULT_COLLAPSED, className } = props;
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [showAll, setShowAll] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const visible = showAll ? messages : messages.slice(-collapsedCount);

  const toggleMessage = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = (): void => {
      if (el.scrollTop < 12 && !showAll && messages.length > collapsedCount) {
        setShowAll(true);
        setExpandedIds(new Set(messages.map((m) => m.id)));
      }
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [showAll, messages, collapsedCount]);

  return (
    <div
      ref={scrollRef}
      className={className}
      data-eliza-companion-stack=""
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 6,
        maxHeight: "60vh",
        overflowY: "auto",
        padding: "0 0 10px",
        scrollbarWidth: "thin",
      }}
    >
      {visible.map((msg) => {
        const expanded = showAll || expandedIds.has(msg.id);
        return (
          <button
            key={msg.id}
            type="button"
            onClick={() => toggleMessage(msg.id)}
            data-role={msg.role}
            data-expanded={expanded ? "true" : "false"}
            style={{
              alignSelf: msg.role === "user" ? "flex-end" : "flex-start",
              maxWidth: "88%",
              padding: expanded ? "9px 13px" : "5px 11px",
              borderRadius: 14,
              fontSize: 12,
              lineHeight: 1.46,
              textAlign: "left",
              color:
                msg.role === "user"
                  ? "rgba(255,255,255,0.96)"
                  : "rgba(255,255,255,0.82)",
              background:
                msg.role === "user"
                  ? "rgba(255,255,255,0.22)"
                  : "rgba(255,255,255,0.14)",
              backdropFilter: "blur(18px) saturate(180%)",
              boxShadow:
                "inset 0 0 0 0.5px rgba(255,255,255,0.32), inset 0 1px 0 rgba(255,255,255,0.42)",
              border: 0,
              cursor: "pointer",
              opacity: expanded ? 1 : 0.84,
              transition: "padding 0.16s ease, opacity 0.16s ease",
            }}
          >
            {expanded
              ? msg.text
              : msg.text.length > 64
                ? `${msg.text.slice(0, 64)}…`
                : msg.text}
          </button>
        );
      })}
    </div>
  );
}
