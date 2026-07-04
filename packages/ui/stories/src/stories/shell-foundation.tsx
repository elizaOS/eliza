/**
 * Story group for the shell foundation (ChatSurface, AssistantOverlay, HomePill).
 */
import { AssistantOverlay } from "@ui-src/components/shell/AssistantOverlay.tsx";
import { ChatSurface } from "@ui-src/components/shell/ChatSurface.tsx";
import { HomePill } from "@ui-src/components/shell/HomePill.tsx";
import type {
  ShellMessage,
  ShellPhase,
} from "@ui-src/components/shell/shell-state.ts";

import type { StoryDefinition } from "../Story.tsx";

const phases: readonly ShellPhase[] = [
  "booting",
  "idle",
  "summoned",
  "listening",
  "responding",
];

const sampleMessages: ShellMessage[] = [
  {
    id: "g1",
    role: "assistant",
    content: "Good morning! What would you like to do?",
    createdAt: 0,
  },
  {
    id: "u1",
    role: "user",
    content: "Remind me to call Alex at 3pm",
    createdAt: 1,
  },
  {
    id: "a1",
    role: "assistant",
    content: "Done — reminder set for 3:00 PM.",
    createdAt: 2,
  },
];

const noop = (): void => undefined;

export const shellFoundationStories: StoryDefinition[] = [
  {
    id: "shell-home-pill",
    name: "HomePill — all phases",
    importPath: 'import { HomePill } from "@elizaos/ui"',
    description:
      "Persistent bottom-center pill. Visual reflects shell phase; disabled while booting.",
    render: () => (
      <div className="grid grid-cols-1 gap-12 p-12 sm:grid-cols-3">
        {phases.map((phase) => (
          <div
            key={phase}
            className="relative h-32 rounded-xl border border-border/30 bg-bg/40"
          >
            <span className="absolute left-2 top-2 text-xs text-muted">
              {phase}
            </span>
            <HomePill phase={phase} onOpen={noop} onClose={noop} />
          </div>
        ))}
      </div>
    ),
  },
  {
    id: "shell-chat-empty",
    name: "ChatSurface — empty greeting",
    importPath: 'import { ChatSurface } from "@elizaos/ui"',
    render: () => (
      <div className="h-[60vh] w-[min(560px,90vw)] rounded-3xl border border-border/40 bg-bg/95">
        <ChatSurface
          messages={[]}
          onSend={noop}
          canSend={true}
          greeting="Good morning! What would you like to do?"
        />
      </div>
    ),
  },
  {
    id: "shell-chat-messages",
    name: "ChatSurface — with messages",
    importPath: 'import { ChatSurface } from "@elizaos/ui"',
    render: () => (
      <div className="h-[60vh] w-[min(560px,90vw)] rounded-3xl border border-border/40 bg-bg/95">
        <ChatSurface messages={sampleMessages} onSend={noop} canSend={true} />
      </div>
    ),
  },
  {
    id: "shell-chat-streaming",
    name: "ChatSurface — streaming (typing indicator)",
    importPath: 'import { ChatSurface } from "@elizaos/ui"',
    description:
      "When the trailing assistant message is empty, the typing indicator renders in place of the bubble content.",
    render: () => {
      const messages: ShellMessage[] = [
        ...sampleMessages,
        { id: "u2", role: "user", content: "And another thing…", createdAt: 3 },
        { id: "a2", role: "assistant", content: "", createdAt: 4 },
      ];
      return (
        <div className="h-[60vh] w-[min(560px,90vw)] rounded-3xl border border-border/40 bg-bg/95">
          <ChatSurface messages={messages} onSend={noop} canSend={false} />
        </div>
      );
    },
  },
  {
    id: "shell-chat-disabled",
    name: "ChatSurface — disabled (offline)",
    importPath: 'import { ChatSurface } from "@elizaos/ui"',
    render: () => (
      <div className="h-[60vh] w-[min(560px,90vw)] rounded-3xl border border-border/40 bg-bg/95">
        <ChatSurface messages={sampleMessages} onSend={noop} canSend={false} />
      </div>
    ),
  },
  {
    id: "shell-overlay-open",
    name: "AssistantOverlay — open with chat",
    importPath: 'import { AssistantOverlay, ChatSurface } from "@elizaos/ui"',
    description:
      "AssistantOverlay is a fixed dialog container. Inside the catalog tile we render it relative-positioned so it sits within the surface card.",
    render: () => (
      <div className="relative h-[60vh] w-full overflow-hidden rounded-2xl border border-border/40 bg-card/40">
        <AssistantOverlay phase="summoned" onClose={noop}>
          <ChatSurface messages={sampleMessages} onSend={noop} canSend={true} />
        </AssistantOverlay>
      </div>
    ),
  },
];
