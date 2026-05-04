"use client";

import {
  Badge,
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from "@elizaos/cloud-ui";
import { ArrowUp, Loader2, RotateCcw, SlidersHorizontal, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useAvailableModels } from "./hooks/use-available-models";
import {
  buildResponsesInput,
  extractPlaygroundErrorMessage,
  extractPlaygroundResponseText,
  extractPlaygroundUsage,
  type PlaygroundUsage,
} from "./model-playground-utils";

const DEFAULT_SYSTEM_PROMPT =
  "You are a concise model evaluation assistant. Answer directly, note tradeoffs when relevant, and avoid unnecessary filler.";

interface TranscriptMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  modelId?: string;
  latencyMs?: number;
  usage?: PlaygroundUsage | null;
}

function formatMetricList(message: TranscriptMessage): string | null {
  const parts: string[] = [];

  if (message.modelId) {
    parts.push(message.modelId);
  }

  if (typeof message.latencyMs === "number") {
    parts.push(`${(message.latencyMs / 1000).toFixed(1)}s`);
  }

  if (message.usage?.totalTokens) {
    parts.push(`${message.usage.totalTokens.toLocaleString()} tokens`);
  }

  return parts.length > 0 ? parts.join(" - ") : null;
}

export function ModelPlayground() {
  const { models, isLoading, error } = useAvailableModels();
  const [selectedModelId, setSelectedModelId] = useState("");
  const [systemPrompt, setSystemPrompt] = useState(DEFAULT_SYSTEM_PROMPT);
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<TranscriptMessage[]>([]);
  const [isSending, setIsSending] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!selectedModelId && models[0]) {
      setSelectedModelId(models[0].modelId);
    }
  }, [models, selectedModelId]);

  useEffect(() => {
    const container = transcriptRef.current;
    if (!container) {
      return;
    }

    const nextTop = container.scrollHeight;
    container.scrollTo({
      top: nextTop,
      behavior: messages.length > 0 ? "smooth" : "auto",
    });
  }, [messages]);

  const selectedModel = models.find((model) => model.modelId === selectedModelId) ?? models[0];

  const handleNewChat = () => {
    setMessages([]);
    setDraft("");
    setLastError(null);
  };

  const handleSend = async () => {
    const content = draft.trim();

    if (!content || isSending) {
      return;
    }

    if (!selectedModelId) {
      toast.error("Select a model before sending a message.");
      return;
    }

    const userMessage: TranscriptMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content,
    };
    const nextMessages = [...messages, userMessage];

    setMessages(nextMessages);
    setDraft("");
    setLastError(null);
    setIsSending(true);

    const startedAt = performance.now();

    try {
      const response = await fetch("/api/v1/responses", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        credentials: "include",
        body: JSON.stringify({
          model: selectedModelId,
          instructions: systemPrompt,
          input: buildResponsesInput(nextMessages),
        }),
      });

      const payload = await response.json().catch(() => null);

      if (!response.ok) {
        throw new Error(extractPlaygroundErrorMessage(payload, response.status));
      }

      const responseText = extractPlaygroundResponseText(payload);
      if (!responseText) {
        throw new Error("The model returned an empty response.");
      }

      setMessages((currentMessages) => [
        ...currentMessages,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content: responseText,
          modelId: selectedModelId,
          latencyMs: Math.round(performance.now() - startedAt),
          usage: extractPlaygroundUsage(payload),
        },
      ]);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "The model request failed. Please try again.";
      setLastError(message);
      toast.error(message);
    } finally {
      setIsSending(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden animate-in fade-in duration-300">
      <div className="grid flex-1 min-h-0 gap-4 p-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <section className="flex min-h-0 flex-col overflow-hidden border border-white/10 bg-black/30">
          <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-none border border-[#FF5800]/20 bg-[#FF5800]/10 text-[#FF5800]">
                <Sparkles className="h-5 w-5" />
              </div>
              <div>
                <div className="text-sm font-medium text-white">Model Playground</div>
                <div className="text-sm text-white/45">
                  Direct chat for evaluating models without opening the agent builder.
                </div>
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="gap-2"
              onClick={handleNewChat}
              disabled={isSending || messages.length === 0}
            >
              <RotateCcw className="h-4 w-4" />
              New chat
            </Button>
          </div>

          <div ref={transcriptRef} className="flex-1 overflow-y-auto px-5 py-5">
            {messages.length === 0 ? (
              <div className="flex h-full items-center justify-center">
                <div className="max-w-xl border border-dashed border-white/10 bg-white/[0.02] p-6 text-center">
                  <Badge className="border-[#FF5800]/20 bg-[#FF5800]/10 text-[#FF9A62]">
                    Prompt Lab
                  </Badge>
                  <h2 className="mt-4 text-xl font-semibold text-white">Test raw model behavior</h2>
                  <p className="mt-2 text-sm leading-6 text-white/55">
                    Pick a model, set the system prompt, and run direct chats here. Agent
                    conversations still work when you open a specific agent conversation.
                  </p>
                </div>
              </div>
            ) : (
              <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
                {messages.map((message) => {
                  const metrics = formatMetricList(message);

                  return (
                    <article
                      key={message.id}
                      className={cn(
                        "flex flex-col gap-2",
                        message.role === "user" ? "items-end" : "items-start",
                      )}
                    >
                      <div
                        className={cn(
                          "max-w-[90%] whitespace-pre-wrap border px-4 py-3 text-sm leading-6 md:max-w-[80%]",
                          message.role === "user"
                            ? "border-[#FF5800]/20 bg-[#FF5800]/10 text-white"
                            : "border-white/10 bg-white/[0.03] text-white/90",
                        )}
                      >
                        {message.content}
                      </div>
                      {metrics ? <div className="px-1 text-xs text-white/35">{metrics}</div> : null}
                    </article>
                  );
                })}

                {isSending ? (
                  <div className="flex items-center gap-2 px-1 text-sm text-white/45">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Waiting for model response...
                  </div>
                ) : null}
              </div>
            )}
          </div>

          <div className="border-t border-white/10 bg-black/40 px-5 py-4">
            {lastError ? (
              <div className="mb-3 border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-200">
                {lastError}
              </div>
            ) : null}

            <Textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void handleSend();
                }
              }}
              placeholder="Ask for a comparison, benchmark interpretation, prompt rewrite, or anything else."
              className="min-h-28 resize-y border-white/10 bg-black/50 text-sm"
              disabled={isSending}
            />

            <div className="mt-3 flex items-center justify-between gap-3">
              <div className="text-xs text-white/35">
                Enter sends. Shift+Enter inserts a new line.
              </div>
              <Button
                onClick={() => void handleSend()}
                disabled={isSending || !draft.trim() || !selectedModelId}
                className="gap-2"
              >
                {isSending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <ArrowUp className="h-4 w-4" />
                )}
                Send
              </Button>
            </div>
          </div>
        </section>

        <aside className="flex min-h-0 flex-col gap-4 overflow-auto border border-white/10 bg-black/30 p-4">
          <div className="border border-white/10 bg-white/[0.02] p-4">
            <div className="flex items-center gap-2 text-sm font-medium text-white">
              <SlidersHorizontal className="h-4 w-4 text-[#FF5800]" />
              Session
            </div>

            <div className="mt-4 space-y-2">
              <label className="text-xs uppercase tracking-[0.22em] text-white/40">Model</label>
              <Select
                value={selectedModelId}
                onValueChange={setSelectedModelId}
                disabled={isLoading || models.length === 0 || isSending}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder={isLoading ? "Loading models..." : "Select a model"} />
                </SelectTrigger>
                <SelectContent>
                  {models.map((model) => (
                    <SelectItem key={model.modelId} value={model.modelId}>
                      {model.name} - {model.provider}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {selectedModel ? (
                <div className="text-sm leading-6 text-white/55">
                  <div className="font-medium text-white/80">{selectedModel.name}</div>
                  <div>{selectedModel.description}</div>
                </div>
              ) : null}
              {error ? <div className="text-sm text-amber-300/80">{error}</div> : null}
            </div>
          </div>

          <div className="flex min-h-[280px] flex-1 flex-col border border-white/10 bg-white/[0.02] p-4">
            <div className="text-xs uppercase tracking-[0.22em] text-white/40">System prompt</div>
            <p className="mt-2 text-sm leading-6 text-white/50">
              This instruction is sent with every turn in the current chat.
            </p>
            <Textarea
              value={systemPrompt}
              onChange={(event) => setSystemPrompt(event.target.value)}
              className="mt-4 min-h-[220px] flex-1 resize-none border-white/10 bg-black/50 text-sm"
              placeholder="Describe the behavior you want from the model."
              disabled={isSending}
            />
          </div>
        </aside>
      </div>
    </div>
  );
}
