import { MessageCircle } from "lucide-react";
import type { ReactNode } from "react";
import { useLifeOpsChatAdapter } from "./LifeOpsChatAdapter.helpers.js";
import { useLifeOpsSelection } from "./LifeOpsSelectionContext.helpers.js";

export function LifeOpsChatAdapter({ children }: { children: ReactNode }) {
  const { selection } = useLifeOpsSelection();
  const { placeholder } = useLifeOpsChatAdapter(selection);

  return (
    <div
      className="relative flex h-full flex-col"
      data-testid="lifeops-chat-adapter"
    >
      {placeholder ? (
        <div className="shrink-0 border-b border-border/12 bg-bg/60 px-4 py-1.5">
          <div
            className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-border/12 bg-bg/70 text-muted"
            role="status"
            aria-label={placeholder}
            title={placeholder}
          >
            <MessageCircle className="h-3.5 w-3.5" aria-hidden />
            <span className="sr-only">{placeholder}</span>
          </div>
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </div>
  );
}
