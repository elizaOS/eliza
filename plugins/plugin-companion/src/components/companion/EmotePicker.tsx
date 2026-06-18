import { useAgentElement } from "@elizaos/ui/agent-surface";
import { client } from "@elizaos/ui/api";
import { Button, Input } from "@elizaos/ui/components";
import {
  dispatchAppEvent,
  EMOTE_PICKER_EVENT,
  STOP_EMOTE_EVENT,
} from "@elizaos/ui/events";
import { useTimeout } from "@elizaos/ui/hooks";
import { useApp } from "@elizaos/ui/state";
import { Z_SYSTEM_CRITICAL } from "@elizaos/ui/utils";
import { type LucideIcon, Menu, Sparkles, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EMOTE_CATALOG } from "../../emotes/catalog";
import {
  buildCategoryList,
  buildEmoteGrid,
  CATEGORY_ICONS,
  categoryLabel,
  type EmoteItem,
} from "./emote-picker-grid";

// All emotes — derived from the runtime EMOTE_CATALOG (the exact set the agent
// server's POST /api/emote accepts, validated against EMOTE_BY_ID in
// packages/agent/src/api/misc-routes.ts). Building from the catalog (rather than
// a hand-maintained list) guarantees every clickable item is a server-valid id
// and that no catalog emote is silently omitted. emote-picker-grid.test.ts
// asserts this alignment so the two cannot drift apart again.
const ALL_EMOTES: EmoteItem[] = buildEmoteGrid(EMOTE_CATALOG);
const CATEGORIES = buildCategoryList(ALL_EMOTES);
const CATEGORY_LABELS: Record<string, string> = Object.fromEntries(
  CATEGORIES.map((cat) => [cat, categoryLabel(cat)]),
);

export function EmotePicker() {
  const { setTimeout } = useTimeout();

  const { emotePickerOpen, openEmotePicker, closeEmotePicker, t } = useApp();
  const [search, setSearch] = useState("");
  const [playing, setPlaying] = useState<string | null>(null);
  const [activeCategory, setActiveCategory] = useState<string | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const { ref: searchAgentRef, agentProps: searchAgentProps } =
    useAgentElement<HTMLInputElement>({
      id: "emotes-search",
      role: "text-input",
      label: t("emotepicker.SearchEmotes"),
      group: "emotes-picker",
      description: "Filter the emote grid by name",
      getValue: () => search,
      onFill: (value: string) => setSearch(value),
    });
  const setSearchRef = useCallback(
    (node: HTMLInputElement | null) => {
      inputRef.current = node;
      searchAgentRef.current = node;
    },
    [searchAgentRef],
  );
  const panelRef = useRef<HTMLDivElement>(null);
  const posRef = useRef({ x: 0, y: 0 });
  const dragOrigin = useRef<{
    startX: number;
    startY: number;
    rect: DOMRect;
  } | null>(null);

  // Apply position to panel
  const applyPosition = useCallback((x: number, y: number) => {
    const el = panelRef.current;
    if (!el) return;

    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    el.style.bottom = "auto";
    el.style.right = "auto";

    posRef.current = { x, y };
  }, []);

  // Drag handlers
  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const el = panelRef.current;
      if (!el) return;

      const rect = el.getBoundingClientRect();
      dragOrigin.current = {
        startX: e.clientX,
        startY: e.clientY,
        rect,
      };

      const onPointerMove = (moveEvent: PointerEvent) => {
        if (!dragOrigin.current) return;

        const dx = moveEvent.clientX - dragOrigin.current.startX;
        const dy = moveEvent.clientY - dragOrigin.current.startY;

        let newX = dragOrigin.current.rect.left + dx;
        let newY = dragOrigin.current.rect.top + dy;

        // Clamp to viewport
        const maxX = window.innerWidth - dragOrigin.current.rect.width;
        const maxY = window.innerHeight - dragOrigin.current.rect.height;

        newX = Math.max(0, Math.min(newX, maxX));
        newY = Math.max(0, Math.min(newY, maxY));

        applyPosition(newX, newY);
      };

      const onPointerUp = () => {
        dragOrigin.current = null;
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
      };

      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
    },
    [applyPosition],
  );

  // Reset position on open
  useEffect(() => {
    if (emotePickerOpen && panelRef.current) {
      panelRef.current.style.left = "";
      panelRef.current.style.top = "";
      panelRef.current.style.bottom = "";
      panelRef.current.style.right = "";
      posRef.current = { x: 0, y: 0 };
    }
  }, [emotePickerOpen]);

  // Filter emotes
  const filteredEmotes = useMemo(() => {
    let emotes = ALL_EMOTES;

    if (activeCategory) {
      emotes = emotes.filter((e) => e.category === activeCategory);
    }

    if (search.trim()) {
      const query = search.toLowerCase();
      emotes = emotes.filter(
        (e) =>
          e.name.toLowerCase().includes(query) ||
          e.id.toLowerCase().includes(query),
      );
    }

    return emotes;
  }, [search, activeCategory]);

  // Play emote
  const playEmote = useCallback(
    async (emoteId: string) => {
      setPlaying(emoteId);
      try {
        await client.playEmote(emoteId);
      } catch (err) {
        console.error("Failed to play emote:", err);
      } finally {
        setTimeout(() => setPlaying(null), 1000);
      }
    },
    [setTimeout],
  );

  // Stop emote
  const stopEmote = useCallback(() => {
    dispatchAppEvent(STOP_EMOTE_EVENT);
    setPlaying(null);
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Cmd+E toggle
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "e") {
        e.preventDefault();
        if (emotePickerOpen) {
          closeEmotePicker();
        } else {
          openEmotePicker();
        }
      }

      // Escape to close
      if (e.key === "Escape" && emotePickerOpen) {
        closeEmotePicker();
      }
    };

    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () =>
      window.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [emotePickerOpen, openEmotePicker, closeEmotePicker]);

  // Desktop bridge listener
  useEffect(() => {
    const handleDesktopToggle = () => {
      if (emotePickerOpen) {
        closeEmotePicker();
      } else {
        openEmotePicker();
      }
    };

    document.addEventListener(EMOTE_PICKER_EVENT, handleDesktopToggle);
    return () =>
      document.removeEventListener(EMOTE_PICKER_EVENT, handleDesktopToggle);
  }, [emotePickerOpen, openEmotePicker, closeEmotePicker]);

  // Focus search input on open
  useEffect(() => {
    if (emotePickerOpen && inputRef.current) {
      inputRef.current.focus();
    }
  }, [emotePickerOpen]);

  if (!emotePickerOpen) return null;

  return (
    <div
      ref={panelRef}
      data-testid="emote-picker"
      className="pointer-events-auto fixed bottom-4 left-4 w-[320px] rounded-xl shadow-2xl"
      style={{
        background: "rgba(18, 22, 32, 0.96)",
        border: "1px solid rgba(240, 178, 50, 0.18)",
        backdropFilter: "blur(24px)",
        boxShadow: "0 8px 60px rgba(0,0,0,0.6), 0 0 40px rgba(240,178,50,0.06)",
        zIndex: Z_SYSTEM_CRITICAL,
      }}
    >
      {/* Header */}
      <div
        className="flex cursor-move items-center justify-between px-3 py-2"
        style={{ borderBottom: "1px solid rgba(255,255,255,0.08)" }}
        onPointerDown={onPointerDown}
      >
        <div className="flex items-center gap-2">
          <Menu
            className="w-4 h-4"
            style={{ color: "rgba(255,255,255,0.45)" }}
          />
          <span
            className="text-sm font-semibold"
            style={{ color: "rgba(240,238,250,0.92)" }}
          >
            {t("emotepicker.Emotes")}
          </span>
        </div>

        <div className="flex items-center gap-2">
          {/* Stop button */}
          <EmotePickerStopButton onStop={stopEmote} label={t("game.stop")} />

          {/* Shortcut label */}
          <span className="text-xs" style={{ color: "rgba(255,255,255,0.45)" }}>
            ⌘E
          </span>

          {/* Close button */}
          <EmotePickerCloseButton
            onClose={closeEmotePicker}
            label={t("common.close", { defaultValue: "Close" })}
          />
        </div>
      </div>

      {/* Search */}
      <div
        className="px-3 py-2"
        style={{ borderBottom: "1px solid rgba(255,255,255,0.08)" }}
      >
        <Input
          ref={setSearchRef}
          type="text"
          value={search}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
            setSearch(e.target.value)
          }
          placeholder={t("emotepicker.SearchEmotes")}
          className="w-full rounded px-2 py-1 text-sm focus:outline-none focus:ring-1"
          data-testid="emote-picker-search"
          style={{
            background: "rgba(255,255,255,0.06)",
            color: "rgba(240,238,250,0.92)",
            border: "1px solid rgba(255,255,255,0.1)",
          }}
          {...searchAgentProps}
        />
      </div>

      {/* Category tabs */}
      <div
        className="flex gap-1 overflow-x-auto px-3 py-2"
        style={{ borderBottom: "1px solid rgba(255,255,255,0.08)" }}
      >
        <EmotePickerCategoryButton
          categoryId="all"
          label={t("wallet.all")}
          active={activeCategory === null}
          onSelect={() => setActiveCategory(null)}
        />
        {CATEGORIES.map((cat) => (
          <EmotePickerCategoryButton
            key={cat}
            categoryId={cat}
            label={CATEGORY_LABELS[cat]}
            icon={CATEGORY_ICONS[cat] ?? Sparkles}
            active={activeCategory === cat}
            onSelect={() => setActiveCategory(cat)}
          />
        ))}
      </div>

      {/* Emote grid */}
      <div className="max-h-[400px] overflow-y-auto p-3">
        <div className="grid grid-cols-5 gap-2">
          {filteredEmotes.map((emote: EmoteItem) => (
            <EmotePickerEmoteButton
              key={emote.id}
              emote={emote}
              playing={playing === emote.id}
              onPlay={() => void playEmote(emote.id)}
            />
          ))}
        </div>

        {filteredEmotes.length === 0 && (
          <div
            className="py-8 text-center text-sm"
            style={{ color: "rgba(255,255,255,0.3)" }}
          >
            {t("emotepicker.NoEmotesFound")}
          </div>
        )}
      </div>
    </div>
  );
}

function EmotePickerStopButton({
  onStop,
  label,
}: {
  onStop: () => void;
  label: string;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: "emotes-stop",
    role: "button",
    label,
    group: "emotes-picker",
    description: "Stop the currently playing emote",
  });
  return (
    <Button
      ref={ref}
      variant="destructive"
      size="sm"
      onClick={onStop}
      className="rounded px-2 py-1 text-xs font-medium h-auto"
      data-testid="emote-picker-stop"
      {...agentProps}
    >
      {label}
    </Button>
  );
}

function EmotePickerCloseButton({
  onClose,
  label,
}: {
  onClose: () => void;
  label: string;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: "emotes-close",
    role: "button",
    label,
    group: "emotes-picker",
    description: "Close the emote picker",
  });
  return (
    <Button
      ref={ref}
      variant="ghost"
      size="icon"
      onClick={onClose}
      className="h-auto w-auto p-0"
      aria-label={label}
      data-testid="emote-picker-close"
      style={{ color: "rgba(255,255,255,0.45)" }}
      onMouseEnter={(e: React.MouseEvent<HTMLButtonElement>) => {
        e.currentTarget.style.color = "rgba(240,238,250,0.92)";
      }}
      onMouseLeave={(e: React.MouseEvent<HTMLButtonElement>) => {
        e.currentTarget.style.color = "rgba(255,255,255,0.45)";
      }}
      {...agentProps}
    >
      <X className="w-4 h-4" />
    </Button>
  );
}

function EmotePickerCategoryButton({
  categoryId,
  label,
  icon: CategoryIcon,
  active,
  onSelect,
}: {
  categoryId: string;
  label: string;
  icon?: LucideIcon;
  active: boolean;
  onSelect: () => void;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `emotes-category-${categoryId}`,
    role: "tab",
    label,
    group: "emotes-categories",
    status: active ? "active" : "inactive",
    description: `Filter emotes to the ${label} category`,
  });
  return (
    <Button
      ref={ref}
      variant="ghost"
      size="sm"
      onClick={onSelect}
      className="shrink-0 rounded px-2 py-1 text-xs font-medium h-auto"
      data-testid={`emote-picker-category-${categoryId}`}
      aria-current={active ? "true" : undefined}
      style={{
        background: active ? "var(--accent)" : "rgba(255,255,255,0.06)",
        color: active ? "var(--accent-foreground)" : "rgba(255,255,255,0.6)",
      }}
      {...agentProps}
    >
      {CategoryIcon ? (
        <CategoryIcon className="mr-1 h-3.5 w-3.5" aria-hidden />
      ) : null}
      {label}
    </Button>
  );
}

function EmotePickerEmoteButton({
  emote,
  playing,
  onPlay,
}: {
  emote: EmoteItem;
  playing: boolean;
  onPlay: () => void;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `emotes-play-${emote.id}`,
    role: "list-item",
    label: emote.name,
    group: "emotes-grid",
    status: playing ? "active" : undefined,
    description: `Play the ${emote.name} emote`,
  });
  const EmoteIcon = emote.icon;
  return (
    <Button
      ref={ref}
      variant="ghost"
      size="icon"
      onClick={onPlay}
      disabled={playing}
      aria-label={`Play ${emote.name}`}
      data-testid={`emote-picker-item-${emote.id}`}
      title={emote.name}
      className="flex aspect-square items-center justify-center rounded h-auto w-auto"
      style={{
        background: playing ? "var(--accent)" : "rgba(255,255,255,0.06)",
      }}
      {...agentProps}
    >
      <EmoteIcon className="h-6 w-6" aria-hidden />
    </Button>
  );
}
