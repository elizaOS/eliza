// Composer submit/stop wiring. Sending to a selected thread posts a user
// message (the SSE change-ping then refetches it into the room within ~150ms);
// sending with no thread selected creates one (title = first words, goal =
// message) and selects it. Stop aborts the active sub-agent session.

import { client } from "@elizaos/ui";
import { useCallback, useState } from "react";

function deriveTitle(text: string): string {
  const words = text.trim().split(/\s+/).slice(0, 6).join(" ");
  return words.slice(0, 80) || "New chat";
}

export interface ChatSubmit {
  input: string;
  setInput: (value: string) => void;
  sending: boolean;
  submit: () => void;
  stop: () => void;
}

export function useChatSubmit({
  selectedId,
  activeSessionId,
  onCreated,
}: {
  selectedId: string | null;
  activeSessionId: string | null;
  onCreated: (id: string) => void;
}): ChatSubmit {
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);

  const submit = useCallback(() => {
    const text = input.trim();
    if (!text || sending) return;
    setSending(true);
    setInput("");
    void (async () => {
      try {
        if (selectedId) {
          const ok = await client.postOrchestratorTaskMessage(selectedId, text);
          if (!ok) throw new Error("Message not delivered");
        } else {
          const created = await client.createOrchestratorTask({
            title: deriveTitle(text),
            goal: text,
            originalRequest: text,
          });
          onCreated(created.id);
        }
      } catch {
        // Restore the draft so the user can retry; the room surfaces errors.
        setInput((prev) => (prev ? prev : text));
      } finally {
        setSending(false);
      }
    })();
  }, [input, sending, selectedId, onCreated]);

  const stop = useCallback(() => {
    if (!selectedId || !activeSessionId) return;
    void client
      .stopOrchestratorAgent(selectedId, activeSessionId)
      .catch(() => {});
  }, [selectedId, activeSessionId]);

  return { input, setInput, sending, submit, stop };
}
