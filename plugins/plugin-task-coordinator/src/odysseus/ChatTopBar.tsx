// odysseus chat top bar (.chat-top-bar / .chat-meta-overlay): a centered, dim
// session title with a small dropdown caret affordance. Cost/token meta and the
// export menu land in later phases; the caret is a visual affordance only (no
// session menu is wired yet), so it renders as a non-interactive glyph rather
// than a dead clickable control.

import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";

export function ChatTopBar({ title }: { title: string }): ReactNode {
  return (
    <div className="od-chat-top-bar">
      <span className="od-chat-meta">
        {title}
        <ChevronDown
          size={11}
          className="od-chat-meta-caret"
          aria-hidden="true"
        />
      </span>
    </div>
  );
}
