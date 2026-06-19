// odysseus emoji picker (static/js/emojiPicker.js + .emoji-picker* rules in
// static/style.css). Despite the "emoji" name, this is a MONOCHROME ICON picker
// by design: a curated set of characters that have a genuine text (monochrome)
// presentation, each rendered as an inline Lucide-style SVG. Pure colour emoji
// (grin/cry/thumbs) are intentionally excluded because they have no flat text
// form and so cannot be sent non-coloured. On insert we append U+FE0E
// (VARIATION SELECTOR-15) for any codepoint >= 0x80 so the glyph renders flat
// for the recipient too, not just in this (already-SVG) picker UI.
//
// A popover: a bare search box on top and a single scrollable list of named
// groups, each an 8-column grid of icon buttons (no category-tab strip and no
// "Recent" section — odysseus has neither; the upstream picker stacks every
// group and filters them live by the search box). Clicking an icon inserts its
// character and closes the popover (odysseus emojiPicker.js render(): the cell
// click runs _insertEmoji(char) immediately followed by _closePicker()).
// elizaMapping: this surface is 100% client-side in odysseus too — the icon
// dataset is a static constant — so there is no eliza backend to wire and
// nothing is fabricated.
//
// Host surface: in odysseus the emoji-picker button lives ONLY in the
// document/email markdown formatting toolbar, never in the chat composer (the
// chat composer's bottom-left row is overflow / web-search / shell). The clone's
// chat composer therefore does not mount this picker; it stays exported for the
// document/email editor surface to host. Mounted there, this matches odysseus
// 1:1.

import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";

// Text variation selector (U+FE0E) — appended on insert to characters that
// might render as a colour emoji, asking the browser/recipient to use text
// (monochrome) presentation. Matches emojiPicker.js VS15. Built from the
// codepoint rather than an invisible literal so it survives editing/copy.
const VS15 = String.fromCodePoint(0xfe0e);

interface IconItem {
  // The character actually inserted into the draft (with VS-15 appended for
  // codepoints >= 0x80, mirroring emojiPicker.js _insertEmoji).
  char: string;
  // Searchable label (matches emojiPicker.js item[1]).
  label: string;
  // Inline SVG path content for the cell glyph (the body of the I() helper in
  // emojiPicker.js). Rendered inside a fixed 24x24 stroke SVG.
  path: ReactNode;
}

interface IconGroup {
  name: string;
  items: IconItem[];
}

// ── Icon dataset, 1:1 with emojiPicker.js EMOJI_GROUPS. Each item is a
// monochrome symbol with a real text presentation, drawn as a Lucide-style SVG
// (24x24 viewBox, 2px stroke) so the picker shows flat icons rather than
// system colour emoji. ──
const ICON_GROUPS: IconGroup[] = [
  {
    name: "Faces & Hearts",
    items: [
      {
        char: "☻",
        label: "grin",
        path: (
          <>
            <circle cx="12" cy="12" r="10" />
            <path d="M7 14 C 7 18, 17 18, 17 14 Z" />
            <line x1="9" y1="9" x2="9.01" y2="9" />
            <line x1="15" y1="9" x2="15.01" y2="9" />
          </>
        ),
      },
      {
        char: "♡",
        label: "heart-outline",
        path: (
          <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" />
        ),
      },
      {
        char: "★",
        label: "star",
        path: (
          <polygon
            points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"
            fill="currentColor"
            stroke="none"
          />
        ),
      },
      {
        char: "☆",
        label: "star-outline",
        path: (
          <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
        ),
      },
      {
        char: "✦",
        label: "sparkle",
        path: (
          <polygon
            points="12 2 14 10 22 12 14 14 12 22 10 14 2 12 10 10"
            fill="currentColor"
            stroke="none"
          />
        ),
      },
      {
        char: "☽",
        label: "moon",
        path: <path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z" />,
      },
    ],
  },
  {
    name: "Checks & Marks",
    items: [
      {
        char: "✓",
        label: "check",
        path: <polyline points="20 6 9 17 4 12" />,
      },
      {
        char: "✗",
        label: "cross",
        path: (
          <>
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </>
        ),
      },
      {
        char: "✘",
        label: "cross-heavy",
        path: (
          <>
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </>
        ),
      },
      {
        char: "★",
        label: "star-filled",
        path: (
          <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
        ),
      },
      {
        char: "☆",
        label: "star-empty",
        path: (
          <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
        ),
      },
      {
        char: "●",
        label: "dot",
        path: (
          <circle cx="12" cy="12" r="6" fill="currentColor" stroke="none" />
        ),
      },
      {
        char: "○",
        label: "circle",
        path: <circle cx="12" cy="12" r="8" />,
      },
      {
        char: "■",
        label: "square-filled",
        path: (
          <rect
            x="6"
            y="6"
            width="12"
            height="12"
            fill="currentColor"
            stroke="none"
          />
        ),
      },
      {
        char: "□",
        label: "square-empty",
        path: <rect x="5" y="5" width="14" height="14" />,
      },
      {
        char: "◆",
        label: "diamond",
        path: <polygon points="12 3 21 12 12 21 3 12" />,
      },
      {
        char: "◇",
        label: "diamond-empty",
        path: <polygon points="12 3 21 12 12 21 3 12" />,
      },
      {
        char: "†",
        label: "dagger",
        path: (
          <>
            <line x1="12" y1="4" x2="12" y2="20" />
            <line x1="8" y1="8" x2="16" y2="8" />
          </>
        ),
      },
    ],
  },
  {
    name: "Arrows",
    items: [
      {
        char: "→",
        label: "arrow-right",
        path: (
          <>
            <line x1="5" y1="12" x2="19" y2="12" />
            <polyline points="12 5 19 12 12 19" />
          </>
        ),
      },
      {
        char: "←",
        label: "arrow-left",
        path: (
          <>
            <line x1="19" y1="12" x2="5" y2="12" />
            <polyline points="12 19 5 12 12 5" />
          </>
        ),
      },
      {
        char: "↑",
        label: "arrow-up",
        path: (
          <>
            <line x1="12" y1="19" x2="12" y2="5" />
            <polyline points="5 12 12 5 19 12" />
          </>
        ),
      },
      {
        char: "↓",
        label: "arrow-down",
        path: (
          <>
            <line x1="12" y1="5" x2="12" y2="19" />
            <polyline points="19 12 12 19 5 12" />
          </>
        ),
      },
      {
        char: "⇒",
        label: "arrow-r-dbl",
        path: (
          <>
            <polyline points="10 5 17 12 10 19" />
            <polyline points="6 5 13 12 6 19" />
          </>
        ),
      },
      {
        char: "⇐",
        label: "arrow-l-dbl",
        path: (
          <>
            <polyline points="14 5 7 12 14 19" />
            <polyline points="18 5 11 12 18 19" />
          </>
        ),
      },
    ],
  },
  {
    name: "Math & Punctuation",
    items: [
      {
        char: "±",
        label: "plus-minus",
        path: (
          <>
            <line x1="4" y1="10" x2="20" y2="10" />
            <line x1="12" y1="2" x2="12" y2="18" />
            <line x1="4" y1="20" x2="20" y2="20" />
          </>
        ),
      },
      {
        char: "×",
        label: "multiply",
        path: (
          <>
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </>
        ),
      },
      {
        char: "÷",
        label: "divide",
        path: (
          <>
            <circle cx="12" cy="6" r="1.5" fill="currentColor" stroke="none" />
            <line x1="5" y1="12" x2="19" y2="12" />
            <circle cx="12" cy="18" r="1.5" fill="currentColor" stroke="none" />
          </>
        ),
      },
      {
        char: "≈",
        label: "approx",
        path: (
          <>
            <path d="M4 9 C 6 6, 8 12, 10 9 S 14 6, 16 9 S 20 12, 22 9" />
            <path d="M4 15 C 6 12, 8 18, 10 15 S 14 12, 16 15 S 20 18, 22 15" />
          </>
        ),
      },
      {
        char: "≠",
        label: "not-equal",
        path: (
          <>
            <line x1="5" y1="9" x2="19" y2="9" />
            <line x1="5" y1="15" x2="19" y2="15" />
            <line x1="16" y1="5" x2="8" y2="19" />
          </>
        ),
      },
      {
        char: "≤",
        label: "lte",
        path: (
          <>
            <polyline points="17 5 7 11 17 17" />
            <line x1="7" y1="20" x2="17" y2="20" />
          </>
        ),
      },
      {
        char: "≥",
        label: "gte",
        path: (
          <>
            <polyline points="7 5 17 11 7 17" />
            <line x1="7" y1="20" x2="17" y2="20" />
          </>
        ),
      },
      {
        char: "∞",
        label: "infinity",
        path: (
          <path d="M18.178 8c5.096 0 5.096 8 0 8-5.095 0-7.133-8-12.739-8-4.585 0-4.585 8 0 8 5.606 0 7.644-8 12.739-8z" />
        ),
      },
      {
        char: "π",
        label: "pi",
        path: (
          <>
            <line x1="4" y1="8" x2="20" y2="8" />
            <line x1="9" y1="8" x2="9" y2="20" />
            <line x1="15" y1="8" x2="15" y2="20" />
          </>
        ),
      },
      {
        char: "Σ",
        label: "sum",
        path: <polyline points="6 4 18 4 10 12 18 20 6 20" />,
      },
      {
        char: "∆",
        label: "delta",
        path: <polygon points="12 4 20 20 4 20" />,
      },
      {
        char: "√",
        label: "root",
        path: <polyline points="4 14 8 20 14 4 22 4" />,
      },
      {
        char: "°",
        label: "degree",
        path: <circle cx="12" cy="8" r="3" />,
      },
      {
        char: "§",
        label: "section",
        path: <path d="M14 6 a4 3 0 1 0 -4 4 q-3 0 -3 3 t3 3 q3 0 3 -3" />,
      },
      {
        char: "¶",
        label: "pilcrow",
        path: (
          <>
            <path d="M16 4 H 9 a4 4 0 0 0 0 8 H 12 V 20" />
            <line x1="16" y1="4" x2="16" y2="20" />
          </>
        ),
      },
      {
        char: "•",
        label: "bullet",
        path: (
          <circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" />
        ),
      },
      {
        char: "…",
        label: "ellipsis",
        path: (
          <>
            <circle cx="6" cy="12" r="1.5" fill="currentColor" stroke="none" />
            <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
            <circle cx="18" cy="12" r="1.5" fill="currentColor" stroke="none" />
          </>
        ),
      },
      {
        char: "—",
        label: "em-dash",
        path: <line x1="4" y1="12" x2="20" y2="12" />,
      },
      {
        char: "«",
        label: "quote-l",
        path: (
          <>
            <polyline points="12 5 6 12 12 19" />
            <polyline points="18 5 12 12 18 19" />
          </>
        ),
      },
      {
        char: "»",
        label: "quote-r",
        path: (
          <>
            <polyline points="6 5 12 12 6 19" />
            <polyline points="12 5 18 12 12 19" />
          </>
        ),
      },
      {
        char: '"',
        label: "quote-dbl",
        path: (
          <>
            <line x1="8" y1="5" x2="8" y2="11" />
            <line x1="11" y1="5" x2="11" y2="11" />
            <line x1="13" y1="5" x2="13" y2="11" />
            <line x1="16" y1="5" x2="16" y2="11" />
          </>
        ),
      },
    ],
  },
  {
    name: "Currency & Misc",
    // Currency/typographic glyphs drawn as their own character inside the SVG
    // (matching emojiPicker.js, which uses <text> nodes for these so they keep
    // the picker's monochrome look without bespoke vector art per symbol).
    items: [
      { char: "€", label: "euro", path: <CurrencyGlyph glyph="€" /> },
      { char: "£", label: "pound", path: <CurrencyGlyph glyph="£" /> },
      { char: "¥", label: "yen", path: <CurrencyGlyph glyph="¥" /> },
      { char: "$", label: "dollar", path: <CurrencyGlyph glyph="$" /> },
      { char: "¢", label: "cent", path: <CurrencyGlyph glyph="¢" /> },
      { char: "%", label: "percent", path: <CurrencyGlyph glyph="%" /> },
      {
        char: "‰",
        label: "per-mille",
        path: <CurrencyGlyph glyph="‰" size={13} />,
      },
      {
        char: "№",
        label: "number",
        path: <CurrencyGlyph glyph="№" size={12} />,
      },
    ],
  },
];

// SVG <text> glyph for currency/typographic symbols (emojiPicker.js renders
// these as a <text> node inside the icon SVG rather than as vector strokes).
function CurrencyGlyph({
  glyph,
  size = 16,
}: {
  glyph: string;
  size?: number;
}): ReactNode {
  return (
    <text
      x="12"
      y="16"
      fontSize={size}
      textAnchor="middle"
      fill="currentColor"
      stroke="none"
    >
      {glyph}
    </text>
  );
}

// The picker glyph: a Lucide-style 24x24 stroke SVG wrapping the item's path.
function IconGlyph({ path }: { path: ReactNode }): ReactNode {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {path}
    </svg>
  );
}

export function EmojiPicker({
  open,
  onPick,
  onClose,
  anchorClassName,
}: {
  open: boolean;
  onPick: (emoji: string) => void;
  onClose: () => void;
  anchorClassName?: string;
}): ReactNode {
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset the search + focus the search box each time the popover opens.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    inputRef.current?.focus();
  }, [open]);

  // Escape closes; click outside the popover closes (composer popover pattern,
  // not the modal-overlay backdrop). Listens only while open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onDocPointer = (e: PointerEvent) => {
      const root = rootRef.current;
      if (root && e.target instanceof Node && !root.contains(e.target)) {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDocPointer);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDocPointer);
    };
  }, [open, onClose]);

  // Live filter across every group: match the item label (case-insensitive) or
  // the raw character, dropping groups with no remaining items. Empty query
  // shows all groups. Matches emojiPicker.js render(filter).
  const groups = useMemo<IconGroup[]>(() => {
    const raw = query.trim();
    if (!raw) return ICON_GROUPS;
    const f = raw.toLowerCase();
    const filtered: IconGroup[] = [];
    for (const group of ICON_GROUPS) {
      const items = group.items.filter(
        (item) =>
          item.label.toLowerCase().includes(f) || item.char.includes(raw),
      );
      if (items.length > 0) filtered.push({ name: group.name, items });
    }
    return filtered;
  }, [query]);

  // Insert the character then close. Append VS-15 for codepoints >= 0x80 so the
  // recipient sees a flat/monochrome glyph, not a system colour emoji
  // (emojiPicker.js _insertEmoji). The cell click closes the popover
  // immediately, matching odysseus (render() runs _insertEmoji then
  // _closePicker on each cell click).
  const pick = (char: string) => {
    const cp = char.codePointAt(0);
    const out = cp !== undefined && cp >= 0x80 ? char + VS15 : char;
    onPick(out);
    onClose();
  };

  if (!open) return null;

  const rootClass = anchorClassName
    ? `od-emoji-popover ${anchorClassName}`
    : "od-emoji-popover";

  return (
    <div
      ref={rootRef}
      className={rootClass}
      role="dialog"
      aria-label="Icon picker"
    >
      {/* Bare search input (odysseus .emoji-picker-search is a full-width
          <input> with no leading icon, placeholder "Search…"). */}
      <input
        ref={inputRef}
        className="od-emoji-search-input"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
        }}
        placeholder="Search…"
        aria-label="Search icons"
      />

      {/* Single scrollable stack of groups. Empty groups are dropped and an
          all-empty filter simply renders nothing — odysseus shows no
          "no match" message (render() just skips empty groups). */}
      <div className="od-emoji-body">
        {groups.map((group) => (
          <div className="od-emoji-section" key={group.name}>
            <div className="od-emoji-section-label">{group.name}</div>
            <div className="od-emoji-grid">
              {group.items.map((item) => (
                <button
                  type="button"
                  key={`${group.name}:${item.label}`}
                  className="od-emoji-cell"
                  title={item.label}
                  onClick={() => pick(item.char)}
                >
                  <IconGlyph path={item.path} />
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
