import { create } from "zustand";
import { persist } from "zustand/middleware";
import { nanoid } from "nanoid";
import type { Conversation, Message, AppSettings, ConversationTag } from "./types";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "./constants";

const DEFAULT_SETTINGS: AppSettings = {
  // General
  theme: "dark",
  fontSize: { chat: 14, code: 13 },
  sendOnEnter: true,
  showTimestamps: false,
  compactMode: false,

  // Model
  model: DEFAULT_MODEL,
  maxTokens: 8096,
  temperature: 1.0,
  systemPrompt: "",

  // API
  apiUrl: process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001",
  apiKey: "",
  streamingEnabled: true,

  // Provider — Z.AI is the default across the CLI and this UI.
  provider: DEFAULT_PROVIDER,
  providerKeys: {},

  // Permissions
  permissions: {
    autoApprove: {
      file_read: false,
      file_write: false,
      bash: false,
      web_search: false,
    },
    restrictedDirs: [],
  },

  // MCP
  mcpServers: [],

  // Telegram relay — chat/CLI relay only, allowlisted to a single chat id.
  telegram: {
    botToken: "",
    allowedChatId: "",
  },

  // Keybindings
  keybindings: {
    "new-conversation": "Ctrl+Shift+N",
    "send-message": "Enter",
    "focus-input": "Ctrl+L",
    "toggle-sidebar": "Ctrl+B",
    "open-settings": "Ctrl+,",
    "command-palette": "Ctrl+K",
  },

  // Privacy
  telemetryEnabled: false,
};

interface ChatState {
  conversations: Conversation[];
  activeConversationId: string | null;
  settings: AppSettings;
  settingsOpen: boolean;

  // Sidebar state
  sidebarOpen: boolean;
  sidebarWidth: number;
  sidebarTab: "chats" | "history" | "files" | "settings";
  pinnedIds: string[];
  searchQuery: string;

  // Search & selection state (not persisted)
  isSearchOpen: boolean;
  selectedConversationIds: string[];

  // Persisted search/tag state
  recentSearches: string[];
  tags: ConversationTag[];

  // Conversation actions
  createConversation: () => string;
  setActiveConversation: (id: string) => void;
  deleteConversation: (id: string) => void;
  renameConversation: (id: string, title: string) => void;
  updateConversation: (id: string, updates: Partial<Pick<Conversation, "title" | "model">>) => void;
  addMessage: (conversationId: string, message: Omit<Message, "id" | "createdAt">) => string;
  updateMessage: (conversationId: string, messageId: string, updates: Partial<Message>) => void;
  /** Keep only the first `keepCount` messages in the conversation. */
  truncateMessages: (conversationId: string, keepCount: number) => void;
  getActiveConversation: () => Conversation | null;

  // Bulk actions
  toggleSelectConversation: (id: string) => void;
  clearSelection: () => void;
  bulkDeleteConversations: (ids: string[]) => void;

  // Tag actions
  createTag: (label: string, color: string) => string;
  deleteTag: (id: string) => void;
  updateTag: (id: string, updates: Partial<Pick<ConversationTag, "label" | "color">>) => void;
  tagConversation: (conversationId: string, tagId: string) => void;
  untagConversation: (conversationId: string, tagId: string) => void;

  // Search actions
  openSearch: () => void;
  closeSearch: () => void;
  addRecentSearch: (query: string) => void;
  clearRecentSearches: () => void;

  // Settings actions
  updateSettings: (settings: Partial<AppSettings>) => void;
  resetSettings: (section?: string) => void;
  openSettings: () => void;
  closeSettings: () => void;

  // Sidebar actions
  toggleSidebar: () => void;
  setSidebarWidth: (w: number) => void;
  setSidebarTab: (tab: "chats" | "history" | "files" | "settings") => void;
  pinConversation: (id: string) => void;
  setSearchQuery: (q: string) => void;
}

export const useChatStore = create<ChatState>()(
  persist(
    (set, get) => ({
      conversations: [],
      activeConversationId: null,
      settings: DEFAULT_SETTINGS,
      settingsOpen: false,

      sidebarOpen: true,
      sidebarWidth: 280,
      sidebarTab: "chats",
      pinnedIds: [],
      searchQuery: "",

      isSearchOpen: false,
      selectedConversationIds: [],

      recentSearches: [],
      tags: [],

      createConversation: () => {
        const id = nanoid();
        const now = Date.now();
        const conversation: Conversation = {
          id,
          title: "New conversation",
          messages: [],
          createdAt: now,
          updatedAt: now,
          model: get().settings.model,
          tags: [],
        };
        set((state) => ({
          conversations: [conversation, ...state.conversations],
          activeConversationId: id,
          sidebarTab: "chats",
        }));
        return id;
      },

      setActiveConversation: (id) => {
        set({ activeConversationId: id, sidebarTab: "chats" });
      },

      deleteConversation: (id) => {
        set((state) => {
          const remaining = state.conversations.filter((c) => c.id !== id);
          const nextActive =
            state.activeConversationId === id
              ? (remaining[0]?.id ?? null)
              : state.activeConversationId;
          return {
            conversations: remaining,
            activeConversationId: nextActive,
            pinnedIds: state.pinnedIds.filter((pid) => pid !== id),
          };
        });
      },

      renameConversation: (id, title) => {
        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.id === id ? { ...c, title, updatedAt: Date.now() } : c
          ),
        }));
      },

      updateConversation: (id, updates) => {
        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.id === id ? { ...c, ...updates, updatedAt: Date.now() } : c
          ),
        }));
      },

      addMessage: (conversationId, message) => {
        const id = nanoid();
        const now = Date.now();
        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.id === conversationId
              ? {
                  ...c,
                  messages: [...c.messages, { ...message, id, createdAt: now }],
                  updatedAt: now,
                }
              : c
          ),
        }));
        return id;
      },

      updateMessage: (conversationId, messageId, updates) => {
        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.id === conversationId
              ? {
                  ...c,
                  messages: c.messages.map((m) =>
                    m.id === messageId ? { ...m, ...updates } : m
                  ),
                  updatedAt: Date.now(),
                }
              : c
          ),
        }));
      },

      truncateMessages: (conversationId, keepCount) => {
        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.id === conversationId
              ? { ...c, messages: c.messages.slice(0, keepCount), updatedAt: Date.now() }
              : c
          ),
        }));
      },

      toggleSelectConversation: (id) => {
        set((state) => ({
          selectedConversationIds: state.selectedConversationIds.includes(id)
            ? state.selectedConversationIds.filter((sid) => sid !== id)
            : [...state.selectedConversationIds, id],
        }));
      },

      clearSelection: () => set({ selectedConversationIds: [] }),

      bulkDeleteConversations: (ids) => {
        set((state) => {
          const idSet = new Set(ids);
          const remaining = state.conversations.filter((c) => !idSet.has(c.id));
          const nextActive =
            state.activeConversationId && idSet.has(state.activeConversationId)
              ? (remaining[0]?.id ?? null)
              : state.activeConversationId;
          return {
            conversations: remaining,
            activeConversationId: nextActive,
            pinnedIds: state.pinnedIds.filter((pid) => !idSet.has(pid)),
            selectedConversationIds: [],
          };
        });
      },

      createTag: (label, color) => {
        const id = nanoid();
        set((state) => ({ tags: [...state.tags, { id, label, color }] }));
        return id;
      },

      deleteTag: (id) => {
        set((state) => ({
          tags: state.tags.filter((t) => t.id !== id),
          conversations: state.conversations.map((c) => ({
            ...c,
            tags: c.tags?.filter((tid) => tid !== id),
          })),
        }));
      },

      updateTag: (id, updates) => {
        set((state) => ({
          tags: state.tags.map((t) => (t.id === id ? { ...t, ...updates } : t)),
        }));
      },

      tagConversation: (conversationId, tagId) => {
        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.id === conversationId
              ? { ...c, tags: [...new Set([...(c.tags ?? []), tagId])] }
              : c
          ),
        }));
      },

      untagConversation: (conversationId, tagId) => {
        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.id === conversationId
              ? { ...c, tags: c.tags?.filter((tid) => tid !== tagId) }
              : c
          ),
        }));
      },

      openSearch: () => set({ isSearchOpen: true }),
      closeSearch: () => set({ isSearchOpen: false }),

      addRecentSearch: (query) => {
        if (!query.trim()) return;
        set((state) => ({
          recentSearches: [
            query,
            ...state.recentSearches.filter((s) => s !== query),
          ].slice(0, 10),
        }));
      },

      clearRecentSearches: () => set({ recentSearches: [] }),

      updateSettings: (settings) => {
        set((state) => ({
          settings: { ...state.settings, ...settings },
        }));
      },

      resetSettings: (section) => {
        if (!section) {
          set({ settings: DEFAULT_SETTINGS });
          return;
        }
        const sectionDefaults: Record<string, Partial<AppSettings>> = {
          general: {
            theme: DEFAULT_SETTINGS.theme,
            fontSize: DEFAULT_SETTINGS.fontSize,
            sendOnEnter: DEFAULT_SETTINGS.sendOnEnter,
            showTimestamps: DEFAULT_SETTINGS.showTimestamps,
            compactMode: DEFAULT_SETTINGS.compactMode,
          },
          model: {
            model: DEFAULT_SETTINGS.model,
            maxTokens: DEFAULT_SETTINGS.maxTokens,
            temperature: DEFAULT_SETTINGS.temperature,
            systemPrompt: DEFAULT_SETTINGS.systemPrompt,
          },
          api: {
            apiUrl: DEFAULT_SETTINGS.apiUrl,
            streamingEnabled: DEFAULT_SETTINGS.streamingEnabled,
          },
          provider: {
            provider: DEFAULT_SETTINGS.provider,
            providerKeys: DEFAULT_SETTINGS.providerKeys,
          },
          telegram: { telegram: DEFAULT_SETTINGS.telegram },
          permissions: { permissions: DEFAULT_SETTINGS.permissions },
          keybindings: { keybindings: DEFAULT_SETTINGS.keybindings },
          data: { telemetryEnabled: DEFAULT_SETTINGS.telemetryEnabled },
        };
        const defaults = sectionDefaults[section];
        if (defaults) {
          set((state) => ({ settings: { ...state.settings, ...defaults } }));
        }
      },

      openSettings: () => set({ settingsOpen: true }),
      closeSettings: () => set({ settingsOpen: false }),

      toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
      setSidebarWidth: (w) => set({ sidebarWidth: w }),
      setSidebarTab: (tab) => set({ sidebarTab: tab }),
      pinConversation: (id) =>
        set((state) => ({
          pinnedIds: state.pinnedIds.includes(id)
            ? state.pinnedIds.filter((pid) => pid !== id)
            : [id, ...state.pinnedIds],
        })),
      setSearchQuery: (q) => set({ searchQuery: q }),

      getActiveConversation: () => {
        const state = get();
        return (
          state.conversations.find((c) => c.id === state.activeConversationId) ??
          null
        );
      },
    }),
    {
      name: "claude-code-chat",
      partialize: (state) => ({
        conversations: state.conversations,
        activeConversationId: state.activeConversationId,
        settings: state.settings,
        pinnedIds: state.pinnedIds,
        recentSearches: state.recentSearches,
        tags: state.tags,
      }),
      merge: (persisted, current) => ({
        ...current,
        ...(persisted as object),
        settings: {
          ...DEFAULT_SETTINGS,
          ...((persisted as { settings?: Partial<AppSettings> }).settings ?? {}),
        },
        // Never persist UI state
        settingsOpen: false,
        isSearchOpen: false,
        sidebarTab: "chats",
        selectedConversationIds: [],
      }),
    }
  )
);
