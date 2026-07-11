/**
 * Backend-free, device-runnable chat UX gallery.
 *
 * This mounts the production glass message row + MessageContent/widget parser
 * inside a local transcript. It is intended for Capacitor simulator design
 * review: every interaction stays in memory and no API server is required.
 */
import { RotateCcw, Send, Sparkles } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import type { ConversationMessage } from "../../api/client-types-chat";
import { MockAppProvider } from "../../storybook/mock-providers";
import { ChatMessage } from "../composites/chat/chat-message";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { MessageContent } from "./MessageContent";
import { registerTaskWidget } from "./widgets/task-widget";

registerTaskWidget();

const FORM = JSON.stringify({
  id: "gallery-contact",
  title: "Plan the launch",
  description: "All controls are live and submit back into this local chat.",
  submitLabel: "Save plan",
  fields: [
    { name: "name", label: "Project name", type: "text", required: true },
    { name: "seats", label: "Team size", type: "number" },
    {
      name: "priority",
      label: "Priority",
      type: "select",
      options: [
        { label: "Normal", value: "normal" },
        { label: "High", value: "high" },
      ],
    },
    { name: "notify", label: "Notify me when ready", type: "checkbox" },
  ],
});

const INITIAL_MESSAGES: ConversationMessage[] = [
  {
    id: "gallery-user-hello",
    role: "user",
    text: "Show me every chat widget so I can tune the mobile UX.",
    timestamp: 1,
  },
  {
    id: "gallery-assistant-intro",
    role: "assistant",
    text: "This is the backend-free chat gallery. Everything below uses the production message renderer and remains interactive.",
    timestamp: 2,
  },
  {
    id: "gallery-choice",
    role: "assistant",
    text: "Choice\n[CHOICE:gallery id=gallery-choice allowCustom=true]\npolish=Polish the glass\ndensity=Tune density\nmotion=Review motion\n[/CHOICE]",
    timestamp: 3,
  },
  {
    id: "gallery-followups",
    role: "assistant",
    text: "Follow-up actions\n[FOLLOWUPS]\nreply:Looks good=Reply\nnavigate:/settings=Navigate\nprompt:Please refine =Prefill composer\n[/FOLLOWUPS]",
    timestamp: 4,
  },
  {
    id: "gallery-form",
    role: "assistant",
    text: `Structured form\n[FORM]\n${FORM}\n[/FORM]`,
    timestamp: 5,
  },
  {
    id: "gallery-workflow",
    role: "assistant",
    text: 'Workflow\n[WORKFLOW]\n{"id":"gallery-workflow","title":"Ship mobile polish","steps":[{"label":"Capture iOS","status":"done"},{"label":"Tune glass","status":"running"},{"label":"Verify Android","status":"pending"}]}\n[/WORKFLOW]',
    timestamp: 6,
  },
  {
    id: "gallery-checklist",
    role: "assistant",
    text: 'Checklist\n[CHECKLIST]\n{"title":"UX review","items":[{"content":"Tap every control","status":"completed"},{"content":"Check safe areas","status":"in_progress"},{"content":"Review keyboard","status":"pending"}]}\n[/CHECKLIST]',
    timestamp: 7,
  },
  {
    id: "gallery-task",
    role: "assistant",
    text: "Coding task\n[TASK:00000000-0000-4000-8000-000000000001]Refine native chat glass[/TASK]",
    timestamp: 8,
  },
  {
    id: "gallery-background",
    role: "assistant",
    text: "Background picker\n[BACKGROUND]",
    timestamp: 9,
  },
  {
    id: "gallery-code",
    role: "assistant",
    text: 'Code block\n```tsx\n<ChatWidgetHarness mode="native" />\n```',
    timestamp: 10,
  },
  {
    id: "gallery-genui",
    role: "assistant",
    text: `Generated UI\n\`\`\`json\n${JSON.stringify({
      root: "gallery-heading",
      state: {},
      elements: {
        "gallery-heading": {
          type: "Heading",
          props: { text: "Interactive generated UI", level: "h3" },
          children: [],
        },
      },
    })}\n\`\`\``,
    timestamp: 10.1,
  },
  {
    id: "gallery-permission",
    role: "assistant",
    text: `Permission request\n\`\`\`json\n${JSON.stringify({
      action: "permission_request",
      permission: "reminders",
      reason:
        "Exercise the native permission card without requesting a real permission.",
      feature: "gallery.reminders",
      fallback_offered: true,
    })}\n\`\`\``,
    timestamp: 10.2,
  },
  {
    id: "gallery-download",
    role: "assistant",
    text: "Downloading the local model for offline chat.",
    timestamp: 11,
    localInference: {
      status: "downloading",
      modelId: "mobile-gallery-model",
      progress: { percent: 42, receivedBytes: 42, totalBytes: 100 },
    },
  },
  {
    id: "gallery-error",
    role: "assistant",
    text: "The provider is temporarily busy. The retry affordance should remain obvious.",
    timestamp: 12,
    failureKind: "rate_limited",
  },
  {
    id: "gallery-secret",
    role: "assistant",
    text: "",
    timestamp: 13,
    secretRequest: {
      key: "GALLERY_API_KEY",
      reason: "Exercise secure input presentation without saving anything.",
      status: "pending",
      delivery: {
        mode: "inline_owner_app",
        canCollectValueInCurrentChannel: true,
      },
      form: {
        type: "sensitive_request_form",
        kind: "secret",
        mode: "inline_owner_app",
        submitLabel: "Test secure submit",
        fields: [
          {
            name: "GALLERY_API_KEY",
            label: "API key",
            input: "secret",
            required: true,
          },
        ],
      },
    },
  },
];

function nextMessage(
  role: ConversationMessage["role"],
  text: string,
  sequence: number,
): ConversationMessage {
  return {
    id: `gallery-local-${sequence}`,
    role,
    text,
    timestamp: 100 + sequence,
  };
}

export function ChatWidgetHarness() {
  const [messages, setMessages] = useState(INITIAL_MESSAGES);
  const [draft, setDraft] = useState("");
  const [events, setEvents] = useState<string[]>([]);

  const append = useCallback(
    (role: ConversationMessage["role"], text: string) => {
      setMessages((current) => [
        ...current,
        nextMessage(role, text, current.length),
      ]);
    },
    [],
  );

  const sendActionMessage = useCallback(
    async (text: string) => {
      setEvents((current) => [`widget → ${text}`, ...current].slice(0, 4));
      append("user", text);
      append("assistant", "Captured locally — no backend request was made.");
    },
    [append],
  );

  const appValue = useMemo(
    () => ({
      sendActionMessage,
      setChatInput: setDraft,
      copyToClipboard: async (text: string) => {
        setEvents((current) =>
          [`copied → ${text.slice(0, 32)}`, ...current].slice(0, 4),
        );
      },
    }),
    [sendActionMessage],
  );

  const submitDraft = () => {
    const text = draft.trim();
    if (!text) return;
    append("user", text);
    append(
      "assistant",
      "Mock response added. Try the message action rail, widgets, scrolling, and keyboard again.",
    );
    setDraft("");
  };

  return (
    <MockAppProvider value={appValue}>
      <main
        data-testid="chat-widget-harness"
        className="relative flex h-[100dvh] min-h-0 w-full flex-col overflow-hidden bg-bg text-txt"
        style={{
          paddingTop:
            "max(var(--safe-area-top, 0px), env(safe-area-inset-top, 0px))",
        }}
      >
        <header className="z-10 flex shrink-0 items-center gap-3 border-b border-border/60 bg-bg/70 px-4 py-3 backdrop-blur-2xl">
          <div className="flex h-10 w-10 items-center justify-center rounded-full border border-white/15 bg-white/10 shadow-sm">
            <Sparkles className="h-4 w-4 text-accent" />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-sm font-semibold">Chat UX Gallery</h1>
            <p className="truncate text-xs text-muted">
              Production widgets · local state · no backend
            </p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Reset gallery"
            onClick={() => {
              setMessages(INITIAL_MESSAGES);
              setEvents([]);
              setDraft("");
            }}
          >
            <RotateCcw className="h-4 w-4" />
          </Button>
        </header>

        <section
          data-testid="chat-widget-harness-thread"
          className="min-h-0 flex-1 touch-pan-y overflow-y-auto overscroll-contain px-3 py-5 sm:px-6"
        >
          <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
            {messages.map((message) => (
              <ChatMessage
                key={message.id}
                appearance="glass"
                message={message}
                userMessagesOnRight
                onCopy={(text) => void appValue.copyToClipboard(text)}
                onLongPressCopy={(text) => void appValue.copyToClipboard(text)}
                onRetry={() =>
                  void sendActionMessage("Retry the previous request")
                }
                renderContent={(row) => (
                  <MessageContent message={row as ConversationMessage} />
                )}
              />
            ))}
            {events.length > 0 ? (
              <aside className="rounded-2xl border border-border/60 bg-surface/60 p-3 text-xs text-muted backdrop-blur-xl">
                <div className="mb-1 font-medium text-txt">Interaction log</div>
                {events.map((event) => (
                  <div key={event} className="truncate">
                    {event}
                  </div>
                ))}
              </aside>
            ) : null}
          </div>
        </section>

        <footer
          className="shrink-0 border-t border-border/60 bg-bg/65 px-3 pt-3 backdrop-blur-2xl"
          style={{
            paddingBottom:
              "calc(max(var(--safe-area-bottom, 0px), env(safe-area-inset-bottom, 0px), var(--android-gesture-inset-bottom, 0px)) + 0.75rem)",
          }}
        >
          <div className="mx-auto flex max-w-2xl items-end gap-2 rounded-[1.5rem] border border-white/15 bg-surface/75 p-2 shadow-lg backdrop-blur-2xl">
            <Textarea
              value={draft}
              aria-label="Gallery message"
              placeholder="Type a local message…"
              rows={1}
              className="min-h-11 flex-1 resize-none border-0 bg-transparent shadow-none focus-visible:ring-0"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  submitDraft();
                }
              }}
            />
            <Button
              type="button"
              size="icon"
              className="h-11 w-11 shrink-0 rounded-full"
              aria-label="Send local message"
              disabled={!draft.trim()}
              onClick={submitDraft}
            >
              <Send className="h-4 w-4" />
            </Button>
          </div>
        </footer>
      </main>
    </MockAppProvider>
  );
}
