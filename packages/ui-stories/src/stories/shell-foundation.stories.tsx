import React from "react";
import {
  AssistantOverlay,
  ChatSurface,
  HomePill,
  type ShellMessage,
  type ShellPhase,
} from "@elizaos/ui";

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

export default {
  title: "Shell Foundation",
};

export const PillStates = () => (
  <div className="grid grid-cols-1 gap-12 p-12 sm:grid-cols-3">
    {phases.map((phase) => (
      <div
        key={phase}
        className="relative h-32 rounded-xl border border-border/30 bg-bg/40"
      >
        <span className="absolute left-2 top-2 text-xs text-muted">{phase}</span>
        <HomePill phase={phase} onOpen={noop} onClose={noop} />
      </div>
    ))}
  </div>
);

export const ChatEmpty = () => (
  <div className="h-[80vh] w-[min(560px,90vw)] rounded-3xl border border-border/40 bg-bg/95">
    <ChatSurface
      messages={[]}
      onSend={noop}
      canSend={true}
      greeting="Good morning! What would you like to do?"
    />
  </div>
);

export const ChatWithMessages = () => (
  <div className="h-[80vh] w-[min(560px,90vw)] rounded-3xl border border-border/40 bg-bg/95">
    <ChatSurface messages={sampleMessages} onSend={noop} canSend={true} />
  </div>
);

export const ChatStreamingPlaceholder = () => {
  const messages: ShellMessage[] = [
    ...sampleMessages,
    { id: "u2", role: "user", content: "And another thing…", createdAt: 3 },
    { id: "a2", role: "assistant", content: "", createdAt: 4 },
  ];
  return (
    <div className="h-[80vh] w-[min(560px,90vw)] rounded-3xl border border-border/40 bg-bg/95">
      <ChatSurface messages={messages} onSend={noop} canSend={false} />
    </div>
  );
};

export const ChatDisabled = () => (
  <div className="h-[80vh] w-[min(560px,90vw)] rounded-3xl border border-border/40 bg-bg/95">
    <ChatSurface messages={sampleMessages} onSend={noop} canSend={false} />
  </div>
);

export const OverlayOpen = () => (
  <AssistantOverlay phase="summoned" onClose={noop}>
    <ChatSurface messages={sampleMessages} onSend={noop} canSend={true} />
  </AssistantOverlay>
);
