import { MessageSquareText, Mic2 } from "lucide-react";
import { type ReactNode, useEffect, useRef } from "react";
import type { LifeOpsSection } from "../hooks/useLifeOpsSection.js";
import {
  ASSISTANT_INTENTS,
  LIFEOPS_VOICE_COMMAND_PROMPT,
} from "./LifeOpsAssistantSection.helpers.js";
import { useLifeOpsChatLauncher } from "./LifeOpsChatAdapter.helpers.js";
import { LifeOpsNavTabs } from "./LifeOpsNavRail.js";

interface LifeOpsWorkspaceShellProps {
  compactLayout: boolean;
  section: LifeOpsSection;
  navigate: (section: LifeOpsSection) => void;
  children: ReactNode;
}

export function LifeOpsWorkspaceShell({
  compactLayout,
  section,
  navigate,
  children,
}: LifeOpsWorkspaceShellProps) {
  const { openLifeOpsChat } = useLifeOpsChatLauncher();
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const commandBriefPrompt =
    ASSISTANT_INTENTS[0]?.prompt ?? "Give me a LifeOps command brief.";

  useEffect(() => {
    if (!compactLayout || typeof window === "undefined") {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      let node: HTMLElement | null = workspaceRef.current;
      while (node) {
        if (node.scrollWidth > node.clientWidth + 1) {
          node.scrollLeft = 0;
        }
        node = node.parentElement;
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [compactLayout]);

  return (
    <div ref={workspaceRef} className="flex h-full min-h-0 min-w-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border/12 bg-bg/90 px-2 py-1.5 backdrop-blur sm:px-3">
        <LifeOpsNavTabs activeSection={section} onNavigate={navigate} />
        <div
          className="ml-auto flex h-8 shrink-0 items-center gap-1"
          data-testid="lifeops-mobile-assistant-dock"
        >
          <button
            type="button"
            data-testid="lifeops-mobile-chat-command"
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-bg-muted/50 hover:text-txt focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
            aria-label="Open LifeOps chat"
            onClick={() =>
              openLifeOpsChat(commandBriefPrompt, {}, { select: true })
            }
          >
            <MessageSquareText className="h-4 w-4" aria-hidden />
          </button>
          <button
            type="button"
            data-testid="lifeops-mobile-voice-command"
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-bg-muted/50 hover:text-txt focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
            aria-label="Open LifeOps voice command"
            onClick={() =>
              openLifeOpsChat(
                LIFEOPS_VOICE_COMMAND_PROMPT,
                {},
                { select: false },
              )
            }
          >
            <Mic2 className="h-4 w-4" aria-hidden />
          </button>
        </div>
      </div>

      <div className="min-h-0 min-w-0 flex-1 overflow-auto px-4 pb-6 pt-4 sm:px-6 sm:pb-8 sm:pt-5 lg:px-8 lg:pt-6">
        {children}
      </div>
    </div>
  );
}
