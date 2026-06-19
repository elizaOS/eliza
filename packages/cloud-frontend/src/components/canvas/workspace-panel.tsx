import {
  BarChart3,
  Bookmark,
  Bot,
  Clock,
  CreditCard,
  Key,
  Plug,
  Server,
  Shield,
  Trash2,
  Zap,
} from "lucide-react";
import { useCallback, useState } from "react";
import { useCanvasStore } from "@/lib/stores/canvas-store";
import { processUserMessage } from "@/lib/stores/cloud-assistant-agent";

const QUICK_ACTIONS = [
  { id: "agents", label: "Agents", prompt: "show my agents", icon: Bot },
  {
    id: "billing",
    label: "Billing",
    prompt: "show billing overview",
    icon: CreditCard,
  },
  { id: "apikeys", label: "API Keys", prompt: "list my api keys", icon: Key },
  {
    id: "analytics",
    label: "Analytics",
    prompt: "show analytics",
    icon: BarChart3,
  },
  {
    id: "security",
    label: "Security",
    prompt: "show security overview",
    icon: Shield,
  },
  {
    id: "connectors",
    label: "Connectors",
    prompt: "show connectors",
    icon: Plug,
  },
  { id: "mcps", label: "MCPs", prompt: "show mcp servers", icon: Server },
];

type Tab = "actions" | "views" | "history";

export function WorkspacePanel() {
  const {
    savedViews,
    activeViewId,
    loadView,
    deleteView,
    messages,
    addMessage,
    setProcessing,
  } = useCanvasStore();

  const [tab, setTab] = useState<Tab>("actions");

  const runPrompt = useCallback(
    (prompt: string) => {
      addMessage({ role: "user", content: prompt });
      setProcessing(true);
      processUserMessage(prompt, useCanvasStore.getState().messages)
        .then((r) =>
          useCanvasStore.getState().addMessage({
            role: "assistant",
            content: r.text,
            spec: r.spec ?? undefined,
          }),
        )
        .catch(() =>
          useCanvasStore.getState().addMessage({
            role: "assistant",
            content: "Something went wrong.",
          }),
        )
        .finally(() => useCanvasStore.getState().setProcessing(false));
    },
    [addMessage, setProcessing],
  );

  const tabs: { id: Tab; label: string; icon: typeof Zap }[] = [
    { id: "actions", label: "Actions", icon: Zap },
    { id: "views", label: "Views", icon: Bookmark },
    { id: "history", label: "History", icon: Clock },
  ];

  return (
    <div className="flex h-full flex-col">
      {/* Tabs */}
      <div className="flex shrink-0 border-b border-white/[0.04]">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className="flex flex-1 items-center justify-center gap-1 px-2 py-2.5 text-[11px] font-medium transition-colors duration-200"
            style={{
              color:
                tab === t.id
                  ? "rgba(255,255,255,0.7)"
                  : "rgba(255,255,255,0.2)",
              borderBottom:
                tab === t.id
                  ? "1px solid rgba(255,88,0,0.5)"
                  : "1px solid transparent",
            }}
          >
            <t.icon className="h-3 w-3" />
            {t.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-3">
        {tab === "actions" && (
          <div className="space-y-0.5">
            {QUICK_ACTIONS.map((a) => (
              <button
                key={a.id}
                type="button"
                onClick={() => runPrompt(a.prompt)}
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2
                  text-[12px] text-white/40 transition-all duration-200
                  hover:bg-white/[0.04] hover:text-white/65"
              >
                <a.icon className="h-3.5 w-3.5 text-white/15" />
                {a.label}
              </button>
            ))}
          </div>
        )}

        {tab === "views" &&
          (savedViews.length === 0 ? (
            <div className="flex flex-col items-center pt-12 text-center">
              <Bookmark className="mb-2 h-6 w-6 text-white/[0.06]" />
              <p className="text-[12px] text-white/20">No saved views</p>
            </div>
          ) : (
            <div className="space-y-0.5">
              {savedViews.map((v) => (
                // biome-ignore lint/a11y/useSemanticElements: contains a nested delete <button>, so a <button> wrapper would be invalid HTML
                <div
                  key={v.id}
                  onClick={() => loadView(v.id)}
                  onKeyDown={(e) => e.key === "Enter" && loadView(v.id)}
                  role="button"
                  tabIndex={0}
                  className="group flex items-center gap-2 rounded-lg px-2.5 py-2 cursor-pointer transition-all duration-200"
                  style={{
                    background:
                      activeViewId === v.id
                        ? "rgba(255,88,0,0.06)"
                        : "transparent",
                    color:
                      activeViewId === v.id
                        ? "rgba(255,255,255,0.7)"
                        : "rgba(255,255,255,0.35)",
                  }}
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[12px]">{v.name}</p>
                  </div>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteView(v.id);
                    }}
                    className="shrink-0 rounded p-0.5 opacity-0 transition-opacity group-hover:opacity-100 text-white/20 hover:text-red-400/60"
                    aria-label="Delete"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          ))}

        {tab === "history" &&
          (messages.filter((m) => m.role === "user").length === 0 ? (
            <div className="flex flex-col items-center pt-12 text-center">
              <Clock className="mb-2 h-6 w-6 text-white/[0.06]" />
              <p className="text-[12px] text-white/20">No history</p>
            </div>
          ) : (
            <div className="space-y-0.5">
              {messages
                .filter((m) => m.role === "user")
                .slice()
                .reverse()
                .slice(0, 15)
                .map((m) => (
                  <div key={m.id} className="rounded-lg px-2.5 py-1.5">
                    <p className="truncate text-[12px] text-white/30">
                      {m.content}
                    </p>
                  </div>
                ))}
            </div>
          ))}
      </div>
    </div>
  );
}
