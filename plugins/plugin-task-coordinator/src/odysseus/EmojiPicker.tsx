// odysseus emoji picker (static/js/emojiPicker.js + .emoji-* rules in
// static/style.css). A composer popover: a search box on top, a horizontal
// category-tab strip, and a scrollable categorized emoji grid; clicking an
// emoji inserts it into the draft. Mirrors odysseus's behaviour where the most
// recently used emoji float to the top under a "Recent" section.
//
// elizaMapping: this surface is 100% client-side in odysseus too — the emoji
// dataset is a static constant and recent picks live in localStorage — so there
// is no eliza backend to wire and nothing is fabricated. It follows the
// composer popover pattern (anchored above the input bar, dismiss on Escape /
// outside-click) rather than the .od-search-overlay panel-view pattern, because
// it is summoned from inside the Composer next to the other tool icons.

import { Clock, Search, Smile } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { readPref, writePref } from "./util/storage";

// localStorage key for the recent-emoji ring, matching odysseus's
// 'odysseus-recent-emojis'. Owned by this component (not a shared PREF_KEYS
// entry) since nothing else reads it.
const RECENT_EMOJIS_KEY = "recent-emojis";
const MAX_RECENT = 24;

interface EmojiCategory {
  id: string;
  label: string;
  // Lucide marker icon for the category tab (odysseus uses an emoji glyph; a
  // lucide icon avoids a CSS unicode escape and stays crisp at tab size).
  emojis: string[];
}

// ── Emoji dataset, 1:1 in spirit with emojiPicker.js EMOJI_DATA. A curated set
// per category (the upstream grid is the same hand-picked list, not the full
// Unicode table). Keyword search matches against the per-emoji keyword map
// below. ──
const EMOJI_CATEGORIES: EmojiCategory[] = [
  {
    id: "smileys",
    label: "Smileys & People",
    emojis: [
      "😀",
      "😃",
      "😄",
      "😁",
      "😆",
      "😅",
      "😂",
      "🤣",
      "😊",
      "😇",
      "🙂",
      "🙃",
      "😉",
      "😌",
      "😍",
      "🥰",
      "😘",
      "😗",
      "😙",
      "😚",
      "😋",
      "😛",
      "😝",
      "😜",
      "🤪",
      "🤨",
      "🧐",
      "🤓",
      "😎",
      "🥸",
      "🤩",
      "🥳",
      "😏",
      "😒",
      "😞",
      "😔",
      "😟",
      "😕",
      "🙁",
      "😣",
      "😖",
      "😫",
      "😩",
      "🥺",
      "😢",
      "😭",
      "😤",
      "😠",
      "😡",
      "🤬",
      "🤯",
      "😳",
      "🥵",
      "🥶",
      "😱",
      "😨",
      "😰",
      "😥",
      "😓",
      "🤗",
      "🤔",
      "🤭",
      "🤫",
      "🤥",
      "😶",
      "😐",
      "😑",
      "😬",
      "🙄",
      "😯",
      "😴",
      "🤤",
      "😪",
      "😵",
      "🤐",
      "🥴",
      "🤢",
      "🤮",
      "🤧",
      "😷",
      "🤒",
      "🤕",
      "🤑",
      "🤠",
      "👋",
      "🤚",
      "✋",
      "🖐️",
      "👌",
      "🤌",
      "✌️",
      "🤞",
      "🤟",
      "🤘",
      "👈",
      "👉",
      "👆",
      "👇",
      "👍",
      "👎",
      "✊",
      "👊",
      "👏",
      "🙌",
      "🙏",
      "💪",
      "🧠",
      "👀",
      "❤️",
      "🔥",
    ],
  },
  {
    id: "animals",
    label: "Animals & Nature",
    emojis: [
      "🐶",
      "🐱",
      "🐭",
      "🐹",
      "🐰",
      "🦊",
      "🐻",
      "🐼",
      "🐨",
      "🐯",
      "🦁",
      "🐮",
      "🐷",
      "🐸",
      "🐵",
      "🐔",
      "🐧",
      "🐦",
      "🐤",
      "🦆",
      "🦅",
      "🦉",
      "🦇",
      "🐺",
      "🐗",
      "🐴",
      "🦄",
      "🐝",
      "🐛",
      "🦋",
      "🐌",
      "🐞",
      "🐜",
      "🦗",
      "🕷️",
      "🦂",
      "🐢",
      "🐍",
      "🦎",
      "🐙",
      "🦑",
      "🦐",
      "🦀",
      "🐡",
      "🐠",
      "🐟",
      "🐬",
      "🐳",
      "🐋",
      "🦈",
      "🌵",
      "🎄",
      "🌲",
      "🌳",
      "🌴",
      "🌱",
      "🌿",
      "🍀",
      "🎍",
      "🌷",
      "🌹",
      "🥀",
      "🌺",
      "🌸",
      "🌼",
      "🌻",
      "🌞",
      "🌝",
      "🌚",
      "⭐",
    ],
  },
  {
    id: "food",
    label: "Food & Drink",
    emojis: [
      "🍏",
      "🍎",
      "🍐",
      "🍊",
      "🍋",
      "🍌",
      "🍉",
      "🍇",
      "🍓",
      "🫐",
      "🍈",
      "🍒",
      "🍑",
      "🥭",
      "🍍",
      "🥥",
      "🥝",
      "🍅",
      "🍆",
      "🥑",
      "🥦",
      "🥬",
      "🥒",
      "🌶️",
      "🌽",
      "🥕",
      "🧄",
      "🧅",
      "🥔",
      "🍠",
      "🥐",
      "🥯",
      "🍞",
      "🥖",
      "🧀",
      "🥚",
      "🍳",
      "🥞",
      "🧇",
      "🥓",
      "🍔",
      "🍟",
      "🍕",
      "🌭",
      "🥪",
      "🌮",
      "🌯",
      "🥗",
      "🍝",
      "🍜",
      "🍲",
      "🍣",
      "🍱",
      "🍛",
      "🍚",
      "🍙",
      "🍰",
      "🎂",
      "🍮",
      "🍭",
      "🍩",
      "🍪",
      "🌰",
      "🍫",
      "🍬",
      "☕",
      "🍵",
      "🥤",
      "🍺",
      "🍷",
    ],
  },
  {
    id: "activities",
    label: "Activities",
    emojis: [
      "⚽",
      "🏀",
      "🏈",
      "⚾",
      "🥎",
      "🎾",
      "🏐",
      "🏉",
      "🥏",
      "🎱",
      "🏓",
      "🏸",
      "🥅",
      "🏒",
      "🏑",
      "🥍",
      "🏏",
      "⛳",
      "🏹",
      "🎣",
      "🥊",
      "🥋",
      "🎽",
      "⛸️",
      "🥌",
      "🛷",
      "🎿",
      "⛷️",
      "🏂",
      "🏋️",
      "🤼",
      "🤸",
      "⛹️",
      "🤺",
      "🤾",
      "🏌️",
      "🏇",
      "🧘",
      "🏄",
      "🏊",
      "🚴",
      "🚵",
      "🎮",
      "🎲",
      "🧩",
      "🎯",
      "🎳",
      "🎼",
      "🎹",
      "🥁",
      "🎷",
      "🎺",
      "🎸",
      "🎻",
      "🎨",
      "🎭",
      "🎪",
      "🎬",
      "🎤",
      "🏆",
    ],
  },
  {
    id: "travel",
    label: "Travel & Places",
    emojis: [
      "🚗",
      "🚕",
      "🚙",
      "🚌",
      "🚎",
      "🏎️",
      "🚓",
      "🚑",
      "🚒",
      "🚐",
      "🚚",
      "🚛",
      "🚜",
      "🛵",
      "🏍️",
      "🚲",
      "🛴",
      "🚏",
      "🛣️",
      "🚦",
      "🚥",
      "🚀",
      "🛸",
      "🚁",
      "✈️",
      "🛩️",
      "🛫",
      "🛬",
      "⛵",
      "🚤",
      "🛳️",
      "⛴️",
      "🚢",
      "⚓",
      "🏝️",
      "🏖️",
      "🏔️",
      "⛰️",
      "🌋",
      "🗻",
      "🏕️",
      "🏜️",
      "🏞️",
      "🏛️",
      "🏰",
      "🗼",
      "🗽",
      "⛩️",
      "🕌",
      "🏟️",
      "🌃",
      "🌆",
      "🌇",
      "🌉",
      "🌁",
      "🏙️",
      "🗺️",
      "🧭",
      "🌍",
      "🌎",
    ],
  },
  {
    id: "objects",
    label: "Objects",
    emojis: [
      "⌚",
      "📱",
      "💻",
      "⌨️",
      "🖥️",
      "🖨️",
      "🖱️",
      "💾",
      "💿",
      "📷",
      "📹",
      "🎥",
      "📞",
      "☎️",
      "📟",
      "📺",
      "📻",
      "🎙️",
      "⏱️",
      "⏰",
      "🔋",
      "🔌",
      "💡",
      "🔦",
      "🕯️",
      "🧯",
      "🛢️",
      "💸",
      "💵",
      "💳",
      "🔧",
      "🔨",
      "⚙️",
      "🧰",
      "🧲",
      "🔫",
      "💣",
      "🔪",
      "🛡️",
      "🔑",
      "🔒",
      "🔓",
      "📿",
      "💎",
      "📦",
      "📫",
      "📮",
      "✉️",
      "📝",
      "📚",
      "📖",
      "🔖",
      "🔗",
      "📎",
      "📐",
      "📏",
      "✂️",
      "🗑️",
      "🔭",
      "🔬",
    ],
  },
  {
    id: "symbols",
    label: "Symbols",
    emojis: [
      "❤️",
      "🧡",
      "💛",
      "💚",
      "💙",
      "💜",
      "🖤",
      "🤍",
      "🤎",
      "💔",
      "❣️",
      "💕",
      "💞",
      "💓",
      "💗",
      "💖",
      "💘",
      "💝",
      "✨",
      "⭐",
      "🌟",
      "💫",
      "⚡",
      "🔥",
      "💥",
      "💯",
      "✅",
      "❌",
      "❓",
      "❗",
      "‼️",
      "⁉️",
      "💤",
      "💢",
      "♻️",
      "⚠️",
      "🚫",
      "✔️",
      "☑️",
      "🔘",
      "🔴",
      "🟠",
      "🟡",
      "🟢",
      "🔵",
      "🟣",
      "⚫",
      "⚪",
      "🟤",
      "🔺",
      "🔻",
      "🔸",
      "🔹",
      "🔶",
      "🔷",
      "🔲",
      "🔳",
      "▶️",
      "⏸️",
      "⏹️",
    ],
  },
];

// Minimal keyword index so search matches names, not just raw glyphs (the only
// emojis the textbox can otherwise filter are ones the user pastes). Mirrors the
// curated emojiPicker.js keyword map for the common picks; an unmatched query
// simply shows no results (honest — never a fabricated hit).
const EMOJI_KEYWORDS: Record<string, string> = {
  "😀": "grin happy smile face",
  "😂": "joy laugh tears lol",
  "🤣": "rofl rolling laugh",
  "😊": "blush happy smile",
  "😍": "love heart eyes",
  "🥰": "love hearts adore",
  "😘": "kiss love",
  "😎": "cool sunglasses",
  "🤔": "think hmm",
  "😢": "cry sad tear",
  "😭": "sob cry bawl",
  "😡": "angry mad rage",
  "🤯": "mind blown shock",
  "🥳": "party celebrate",
  "🙏": "pray thanks please",
  "👍": "thumbs up yes ok like",
  "👎": "thumbs down no dislike",
  "👏": "clap applause",
  "🙌": "raise hands praise",
  "💪": "muscle strong flex",
  "👀": "eyes look watch",
  "❤️": "love heart red",
  "🔥": "fire hot lit flame",
  "✨": "sparkle shine magic",
  "🎉": "party celebrate tada",
  "💯": "hundred perfect score",
  "✅": "check done yes ok",
  "❌": "cross no wrong fail",
  "🚀": "rocket launch ship fast",
  "🐶": "dog puppy",
  "🐱": "cat kitten",
  "🦄": "unicorn",
  "🍕": "pizza food",
  "🍔": "burger food",
  "☕": "coffee tea drink",
  "⚽": "soccer football ball",
  "🎮": "game gaming controller",
  "💻": "laptop computer code",
  "💡": "idea light bulb",
  "🧠": "brain think smart",
  "⚡": "zap lightning fast",
  "💥": "boom bang explosion",
  "🌟": "star glow",
  "⭐": "star",
};

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
  const [activeCat, setActiveCat] = useState(EMOJI_CATEGORIES[0].id);
  const [recent, setRecent] = useState<string[]>([]);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Load recent picks + focus the search box each time the popover opens.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveCat(EMOJI_CATEGORIES[0].id);
    setRecent(readPref<string[]>(RECENT_EMOJIS_KEY, []));
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

  // Filtered result set for the search box: matches the keyword index OR the
  // raw glyph. Empty query → null (show the categorized grid instead).
  const searchResults = useMemo<string[] | null>(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    const hits: string[] = [];
    for (const cat of EMOJI_CATEGORIES) {
      for (const emoji of cat.emojis) {
        const kw = EMOJI_KEYWORDS[emoji] ?? "";
        if (kw.includes(q) || emoji === query.trim()) hits.push(emoji);
      }
    }
    return hits;
  }, [query]);

  const pick = (emoji: string) => {
    const next = [emoji, ...recent.filter((e) => e !== emoji)].slice(
      0,
      MAX_RECENT,
    );
    setRecent(next);
    writePref(RECENT_EMOJIS_KEY, next);
    onPick(emoji);
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
      aria-label="Emoji picker"
    >
      <div className="od-emoji-search">
        <Search size={13} className="od-emoji-search-icon" aria-hidden="true" />
        <input
          ref={inputRef}
          className="od-emoji-search-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
          }}
          placeholder="Search emoji…"
          aria-label="Search emoji"
        />
      </div>

      {searchResults === null ? (
        <div className="od-emoji-tabs" role="tablist" aria-label="Categories">
          {recent.length > 0 ? (
            <button
              type="button"
              role="tab"
              aria-selected={activeCat === "recent"}
              className={`od-emoji-tab${activeCat === "recent" ? " active" : ""}`}
              title="Recent"
              onClick={() => setActiveCat("recent")}
            >
              <Clock size={15} />
            </button>
          ) : null}
          {EMOJI_CATEGORIES.map((cat) => (
            <button
              type="button"
              role="tab"
              key={cat.id}
              aria-selected={activeCat === cat.id}
              className={`od-emoji-tab${activeCat === cat.id ? " active" : ""}`}
              title={cat.label}
              onClick={() => setActiveCat(cat.id)}
            >
              {cat.emojis[0]}
            </button>
          ))}
        </div>
      ) : null}

      <div className="od-emoji-body">
        {searchResults !== null ? (
          searchResults.length === 0 ? (
            <div className="od-emoji-empty">
              <Smile size={18} aria-hidden="true" />
              <span>No emoji match “{query.trim()}”.</span>
            </div>
          ) : (
            <div className="od-emoji-grid">
              {searchResults.map((emoji) => (
                <button
                  type="button"
                  key={emoji}
                  className="od-emoji-cell"
                  title={EMOJI_KEYWORDS[emoji] ?? emoji}
                  onClick={() => pick(emoji)}
                >
                  {emoji}
                </button>
              ))}
            </div>
          )
        ) : activeCat === "recent" && recent.length > 0 ? (
          <div className="od-emoji-section">
            <div className="od-emoji-section-label">Recent</div>
            <div className="od-emoji-grid">
              {recent.map((emoji) => (
                <button
                  type="button"
                  key={`recent-${emoji}`}
                  className="od-emoji-cell"
                  title={EMOJI_KEYWORDS[emoji] ?? emoji}
                  onClick={() => pick(emoji)}
                >
                  {emoji}
                </button>
              ))}
            </div>
          </div>
        ) : (
          EMOJI_CATEGORIES.filter((cat) => cat.id === activeCat).map((cat) => (
            <div className="od-emoji-section" key={cat.id}>
              <div className="od-emoji-section-label">{cat.label}</div>
              <div className="od-emoji-grid">
                {cat.emojis.map((emoji) => (
                  <button
                    type="button"
                    key={emoji}
                    className="od-emoji-cell"
                    title={EMOJI_KEYWORDS[emoji] ?? emoji}
                    onClick={() => pick(emoji)}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
