import { ApiError } from "./types";
import { extractTextContent } from "../utils";
import type { Conversation } from "../types";

// Lazy import to avoid circular deps at module init time
function getStore() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require("../store").useChatStore as import("../store").UseChatStore;
}

// ---------------------------------------------------------------------------
// ConversationAPI — backed by the Zustand client-side store.
// ---------------------------------------------------------------------------
//
// Conversations are not persisted on the backend; they live in localStorage
// via Zustand persist middleware. This API provides a consistent async
// interface so callers don't need to know about the store directly.

export interface ListOptions {
  limit?: number;
  offset?: number;
}

export interface CreateOptions {
  title?: string;
  model?: string;
}

export interface ConversationAPI {
  list(options?: ListOptions): Promise<Conversation[]>;
  get(id: string): Promise<Conversation>;
  create(options?: CreateOptions): Promise<Conversation>;
  update(id: string, updates: Partial<Pick<Conversation, "title" | "model">>): Promise<Conversation>;
  delete(id: string): Promise<void>;
  export(id: string, format: "json" | "markdown"): Promise<Blob>;
}

function findConversation(id: string): Conversation {
  const store = getStore();
  const conv = store.getState().conversations.find((c) => c.id === id);
  if (!conv) throw new ApiError(404, `Conversation ${id} not found`, "not_found");
  return conv;
}

export const conversationAPI: ConversationAPI = {
  async list(opts) {
    const { limit = 20, offset = 0 } = opts ?? {};
    const { conversations } = getStore().getState();
    return conversations.slice(offset, offset + limit);
  },

  async get(id) {
    return findConversation(id);
  },

  async create(opts) {
    const store = getStore();
    const id = store.getState().createConversation();

    if (opts?.title || opts?.model) {
      store.getState().updateConversation(id, {
        ...(opts.title ? { title: opts.title } : {}),
        ...(opts.model ? { model: opts.model } : {}),
      });
    }

    return findConversation(id);
  },

  async update(id, updates) {
    findConversation(id); // throws 404 if missing
    getStore().getState().updateConversation(id, updates);
    return findConversation(id);
  },

  async delete(id) {
    findConversation(id); // throws 404 if missing
    getStore().getState().deleteConversation(id);
  },

  async export(id, format) {
    const conv = findConversation(id);

    if (format === "json") {
      return new Blob([JSON.stringify(conv, null, 2)], {
        type: "application/json",
      });
    }

    // Markdown export
    const lines: string[] = [`# ${conv.title}`, ""];
    const created = new Date(conv.createdAt).toISOString();
    lines.push(`> Exported from Claude Code · ${created}`, "");

    for (const msg of conv.messages) {
      const heading =
        msg.role === "user"
          ? "**You**"
          : msg.role === "assistant"
            ? "**Claude**"
            : `**${msg.role}**`;
      lines.push(heading, "");
      lines.push(extractTextContent(msg.content), "");
      lines.push("---", "");
    }

    return new Blob([lines.join("\n")], { type: "text/markdown" });
  },
};
