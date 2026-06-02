// odysseus chat top bar (.chat-top-bar / .chat-meta-overlay): a centered, dim
// session title. Cost/token meta and the export menu land in later phases.

import type { ReactNode } from "react";

export function ChatTopBar({ title }: { title: string }): ReactNode {
  return (
    <div className="od-chat-top-bar">
      <span className="od-chat-meta">{title}</span>
    </div>
  );
}
