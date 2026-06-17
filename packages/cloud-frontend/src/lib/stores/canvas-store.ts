import type { UiSpec } from "@elizaos/shared/config/ui-spec";
import type { ElizaGenUiSpec } from "@elizaos/ui/genui";
import { create } from "zustand";
import { persist } from "zustand/middleware";

// ── Types ──────────────────────────────────────────────────────────

export interface CanvasMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  spec?: UiSpec;
  createdAt: number;
}

export interface GenuiModeState {
  enabled: boolean;
  spec: ElizaGenUiSpec | null;
}

export interface SavedView {
  id: string;
  name: string;
  description: string;
  spec: UiSpec | null;
  genuiSpec: ElizaGenUiSpec | null;
  createdAt: number;
}

export interface WorkspaceNode {
  id: string;
  name: string;
  type: string; // 'agents' | 'billing' | 'apikeys' | 'analytics' | 'security' | 'connectors' | 'mcps' | 'custom'
  spec: UiSpec | null;
  genuiSpec: ElizaGenUiSpec | null;
  content?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  isMinimized: boolean;
  isMaximized: boolean;
}

export interface WorkspaceView {
  id: string;
  name: string;
  nodes: WorkspaceNode[];
  panX: number;
  panY: number;
}

export interface WorkspaceSnapshot {
  id: string;
  name: string;
  views: WorkspaceView[];
  createdAt: number;
}

export type CanvasMode = "idle" | "chat" | "generating" | "viewing";

// Usage tracking for proactive UI
export interface ActionUsage {
  [actionId: string]: { count: number; lastUsed: number };
}

// ── Store ──────────────────────────────────────────────────────────

export interface CanvasState {
  // Canvas open/close
  canvasOpen: boolean;
  canvasMode: CanvasMode;
  defaultUiMode: "canvas" | "classic";

  // Legacy compat — assistantOpen maps to canvasOpen
  assistantOpen: boolean;

  // Chat
  messages: CanvasMessage[];
  isProcessing: boolean;

  // Specs
  activeSpec: UiSpec | null;
  genui: GenuiModeState;

  // Workspace panel
  workspaceOpen: boolean;
  savedViews: SavedView[];
  activeViewId: string | null;

  // New multi-window workspace views
  views: WorkspaceView[];
  snapshots: WorkspaceSnapshot[];
  assistantPanelOpen: boolean;

  // Usage tracking
  actionUsage: ActionUsage;
  sessionCount: number;
  lastCanvasOpen: number;

  // State — glow animation
  inputGlowActive: boolean;

  // Actions — canvas
  setCanvasOpen: (open: boolean) => void;
  toggleCanvas: () => void;
  setCanvasMode: (mode: CanvasMode) => void;
  setDefaultUiMode: (mode: "canvas" | "classic") => void;

  // Actions — legacy compat
  setAssistantOpen: (open: boolean) => void;
  toggleAssistant: () => void;

  // Actions — chat
  addMessage: (msg: Omit<CanvasMessage, "id" | "createdAt">) => void;
  setProcessing: (v: boolean) => void;
  clearMessages: () => void;

  // Actions — specs
  setActiveSpec: (spec: UiSpec | null) => void;
  clearCanvas: () => void;
  setGenuiMode: (enabled: boolean) => void;
  setGenuiSpec: (spec: ElizaGenUiSpec | null) => void;

  // Actions — workspace
  setWorkspaceOpen: (open: boolean) => void;
  toggleWorkspace: () => void;
  saveCurrentView: (name: string, description?: string) => void;
  loadView: (id: string) => void;
  deleteView: (id: string) => void;
  renameView: (id: string, name: string) => void;

  // Actions — Workspace Views
  openView: (
    name: string,
    type: string,
    spec: UiSpec | null,
    genuiSpec: ElizaGenUiSpec | null,
  ) => void;
  closeView: (id: string) => void;
  addTab: (name: string) => void;
  renameTab: (tabId: string, name: string) => void;
  moveNode: (tabId: string, nodeId: string, x: number, y: number) => void;
  closeNode: (tabId: string, nodeId: string) => void;
  minimizeNode: (tabId: string, nodeId: string, minimized: boolean) => void;
  maximizeNode: (tabId: string, nodeId: string, maximized: boolean) => void;
  resizeNode: (tabId: string, nodeId: string, w: number, h: number) => void;
  setTabPan: (tabId: string, panX: number, panY: number) => void;
  saveWorkspaceSnapshot: (name: string) => void;
  loadWorkspaceSnapshot: (id: string) => void;
  deleteWorkspaceSnapshot: (id: string) => void;
  openChatForNode: (tabId: string, nodeId: string) => void;
  setAssistantPanelOpen: (open: boolean) => void;
  updateViewGenuiSpec: (id: string, genuiSpec: ElizaGenUiSpec | null) => void;
  updateNodeSpec: (nodeId: string, spec: UiSpec | null) => void;
  handleAssistantResponse: (
    text: string,
    spec: UiSpec | null,
    prompt: string,
  ) => void;

  // Compatibility helpers
  minimizeView: (id: string, minimized: boolean) => void;
  maximizeView: (id: string, maximized: boolean) => void;
  setSplitSide: (id: string, side: "left" | "right" | "full") => void;

  // Actions — usage tracking
  trackAction: (actionId: string) => void;
  getTopActions: (n?: number) => string[];
}

export const useCanvasStore = create<CanvasState>()(
  persist(
    (set, get) => ({
      // ── Initial state ──
      // Default to the classic dashboard (OG DashboardLayout). The interactive
      // canvas UI remains available behind the toggle, but is no longer the
      // default surface.
      canvasOpen: false,
      canvasMode: "idle" as CanvasMode,
      defaultUiMode: "classic",
      assistantOpen: false,
      messages: [],
      isProcessing: false,
      activeSpec: null,
      genui: { enabled: false, spec: null },
      workspaceOpen: true,
      savedViews: [],
      activeViewId: null,
      views: [],
      snapshots: [],
      assistantPanelOpen: false,
      actionUsage: {},
      sessionCount: 0,
      lastCanvasOpen: 0,
      inputGlowActive: false,

      // ── Canvas ──
      setCanvasOpen: (open) =>
        set((s) => ({
          canvasOpen: open,
          assistantOpen: open,
          canvasMode: open ? (s.views.length > 0 ? "viewing" : "chat") : "idle",
          sessionCount: open ? s.sessionCount + 1 : s.sessionCount,
          lastCanvasOpen: open ? Date.now() : s.lastCanvasOpen,
        })),

      toggleCanvas: () => {
        const { canvasOpen, sessionCount, views } = get();
        set({
          canvasOpen: !canvasOpen,
          assistantOpen: !canvasOpen,
          canvasMode: !canvasOpen
            ? views.length > 0
              ? "viewing"
              : "chat"
            : "idle",
          sessionCount: !canvasOpen ? sessionCount + 1 : sessionCount,
          lastCanvasOpen: !canvasOpen ? Date.now() : get().lastCanvasOpen,
        });
      },

      setCanvasMode: (mode) => set({ canvasMode: mode }),

      setDefaultUiMode: (mode) => set({ defaultUiMode: mode }),

      // ── Legacy compat ──
      setAssistantOpen: (open) =>
        set((s) => ({
          assistantOpen: open,
          canvasOpen: open,
          canvasMode: open ? (s.views.length > 0 ? "viewing" : "chat") : "idle",
        })),

      toggleAssistant: () => {
        const { canvasOpen, views } = get();
        set({
          canvasOpen: !canvasOpen,
          assistantOpen: !canvasOpen,
          canvasMode: !canvasOpen
            ? views.length > 0
              ? "viewing"
              : "chat"
            : "idle",
        });
      },

      // ── Chat ──
      addMessage: (msg) =>
        set((s) => ({
          messages: [
            ...s.messages,
            { ...msg, id: crypto.randomUUID(), createdAt: Date.now() },
          ],
        })),

      setProcessing: (v) =>
        set({
          isProcessing: v,
          canvasMode: v
            ? "generating"
            : get().views.length > 0
              ? "viewing"
              : "chat",
        }),

      clearMessages: () => set({ messages: [] }),

      // ── Specs ──
      setActiveSpec: (spec) =>
        set({
          activeSpec: spec,
          canvasMode: spec ? "viewing" : "chat",
        }),

      clearCanvas: () =>
        set({
          activeSpec: null,
          messages: [],
          genui: { enabled: false, spec: null },
          canvasMode: "chat",
          activeViewId: null,
          views: [],
        }),

      setGenuiMode: (enabled) =>
        set((s) => ({ genui: { ...s.genui, enabled } })),

      setGenuiSpec: (spec) =>
        set((s) => ({
          genui: { ...s.genui, spec },
          canvasMode: spec ? "viewing" : s.canvasMode,
        })),

      // ── Workspace ──
      setWorkspaceOpen: (open) => set({ workspaceOpen: open }),

      toggleWorkspace: () => set((s) => ({ workspaceOpen: !s.workspaceOpen })),

      saveCurrentView: (name, description = "") => {
        const { activeSpec, genui } = get();
        if (!activeSpec && !genui.spec) return;

        const view: SavedView = {
          id: crypto.randomUUID(),
          name,
          description,
          spec: activeSpec,
          genuiSpec: genui.spec,
          createdAt: Date.now(),
        };

        set((s) => ({
          savedViews: [view, ...s.savedViews],
          activeViewId: view.id,
        }));
      },

      loadView: (id) => {
        const { savedViews } = get();
        const view = savedViews.find((v) => v.id === id);
        if (!view) return;

        set({
          activeViewId: id,
          activeSpec: view.spec,
          genui: {
            enabled: !!view.genuiSpec,
            spec: view.genuiSpec,
          },
          canvasMode: "viewing",
        });
      },

      deleteView: (id) =>
        set((s) => ({
          savedViews: s.savedViews.filter((v) => v.id !== id),
          activeViewId: s.activeViewId === id ? null : s.activeViewId,
        })),

      renameView: (id, name) =>
        set((s) => ({
          savedViews: s.savedViews.map((v) =>
            v.id === id ? { ...v, name } : v,
          ),
        })),

      // ── Workspace Views ──
      openView: (name, type, spec, genuiSpec) => {
        const nodeId = crypto.randomUUID();
        const newNode: WorkspaceNode = {
          id: nodeId,
          name,
          type,
          spec,
          genuiSpec,
          x: 100,
          y: 100,
          width: 420,
          height: 480,
          isMinimized: false,
          isMaximized: false,
        };

        set((state) => {
          const nextViews = [...state.views];
          let activeId = state.activeViewId;

          let activeTab = nextViews.find((v) => v.id === activeId);
          if (!activeTab) {
            activeId = crypto.randomUUID();
            activeTab = {
              id: activeId,
              name: name || "Workspace",
              nodes: [],
              panX: 0,
              panY: 0,
            };
            nextViews.push(activeTab);
          } else if (!activeTab.nodes) {
            activeTab.nodes = [];
            activeTab.panX = 0;
            activeTab.panY = 0;
          }

          const count = activeTab.nodes.length;
          newNode.x = 100 + count * 40;
          newNode.y = 100 + count * 40;
          activeTab.nodes = [...activeTab.nodes, newNode];

          return {
            views: nextViews,
            activeViewId: activeId,
            canvasMode: "viewing" as CanvasMode,
          };
        });
      },

      closeView: (id) => {
        set((state) => {
          const remaining = state.views.filter((v) => v.id !== id);
          let nextActive = state.activeViewId;
          if (state.activeViewId === id) {
            nextActive =
              remaining.length > 0 ? remaining[remaining.length - 1].id : null;
          }
          return {
            views: remaining,
            activeViewId: nextActive,
            canvasMode: remaining.length > 0 ? "viewing" : "chat",
          };
        });
      },

      addTab: (name) => {
        const id = crypto.randomUUID();
        const newTab: WorkspaceView = {
          id,
          name,
          nodes: [],
          panX: 0,
          panY: 0,
        };
        set((state) => ({
          views: [...state.views, newTab],
          activeViewId: id,
          canvasMode: "viewing",
        }));
      },

      renameTab: (tabId, name) => {
        set((state) => ({
          views: state.views.map((v) => (v.id === tabId ? { ...v, name } : v)),
        }));
      },

      moveNode: (tabId, nodeId, x, y) => {
        set((state) => ({
          views: state.views.map((v) => {
            if (v.id !== tabId) return v;
            const nodes = v.nodes || [];
            return {
              ...v,
              nodes: nodes.map((n) => (n.id === nodeId ? { ...n, x, y } : n)),
            };
          }),
        }));
      },

      closeNode: (tabId, nodeId) => {
        set((state) => ({
          views: state.views.map((v) => {
            if (v.id !== tabId) return v;
            const nodes = v.nodes || [];
            return {
              ...v,
              nodes: nodes.filter((n) => n.id !== nodeId),
            };
          }),
        }));
      },

      minimizeNode: (tabId, nodeId, minimized) => {
        set((state) => ({
          views: state.views.map((v) => {
            if (v.id !== tabId) return v;
            const nodes = v.nodes || [];
            return {
              ...v,
              nodes: nodes.map((n) =>
                n.id === nodeId ? { ...n, isMinimized: minimized } : n,
              ),
            };
          }),
        }));
      },

      maximizeNode: (tabId, nodeId, maximized) => {
        set((state) => ({
          views: state.views.map((v) => {
            if (v.id !== tabId) return v;
            const nodes = v.nodes || [];
            return {
              ...v,
              nodes: nodes.map((n) =>
                n.id === nodeId
                  ? { ...n, isMaximized: maximized }
                  : { ...n, isMaximized: false },
              ),
            };
          }),
        }));
      },

      resizeNode: (tabId, nodeId, w, h) => {
        set((state) => ({
          views: state.views.map((v) => {
            if (v.id !== tabId) return v;
            const nodes = v.nodes || [];
            return {
              ...v,
              nodes: nodes.map((n) =>
                n.id === nodeId ? { ...n, width: w, height: h } : n,
              ),
            };
          }),
        }));
      },

      setTabPan: (tabId, panX, panY) => {
        set((state) => ({
          views: state.views.map((v) =>
            v.id === tabId ? { ...v, panX, panY } : v,
          ),
        }));
      },

      saveWorkspaceSnapshot: (name) => {
        const { views } = get();
        if (views.length === 0) return;
        const snapshot: WorkspaceSnapshot = {
          id: crypto.randomUUID(),
          name,
          views: JSON.parse(JSON.stringify(views)),
          createdAt: Date.now(),
        };
        set((state) => ({
          snapshots: [snapshot, ...state.snapshots],
        }));
      },

      loadWorkspaceSnapshot: (id) => {
        const { snapshots } = get();
        const snapshot = snapshots.find((s) => s.id === id);
        if (!snapshot) return;

        const migratedViews = snapshot.views.map((v: any) => ({
          id: v.id,
          name: v.name,
          nodes:
            v.nodes ||
            (v.spec || v.genuiSpec
              ? [
                  {
                    id: crypto.randomUUID(),
                    name: v.name,
                    type: v.type || "custom",
                    spec: v.spec,
                    genuiSpec: v.genuiSpec,
                    x: 100,
                    y: 100,
                    width: 420,
                    height: 480,
                    isMinimized: false,
                    isMaximized: false,
                  },
                ]
              : []),
          panX: v.panX || 0,
          panY: v.panY || 0,
        }));

        set({
          views: migratedViews,
          activeViewId: migratedViews.length > 0 ? migratedViews[0].id : null,
          canvasMode: migratedViews.length > 0 ? "viewing" : "chat",
        });
      },

      deleteWorkspaceSnapshot: (id) => {
        set((state) => ({
          snapshots: state.snapshots.filter((s) => s.id !== id),
        }));
      },

      openChatForNode: (tabId, nodeId) => {
        set((state) => {
          const nextViews = state.views.map((v) => {
            if (v.id !== tabId) return v;
            const nodes = v.nodes || [];
            const targetNode = nodes.find((n) => n.id === nodeId);
            if (!targetNode) return v;

            const oldCx = targetNode.x + targetNode.width / 2;
            const oldCy = targetNode.y + targetNode.height / 2;

            // Expand target node to larger size
            const newWidth = Math.max(targetNode.width, 700);
            const newHeight = Math.max(targetNode.height, 480);
            const newX = oldCx - newWidth / 2;
            const newY = oldCy - newHeight / 2;

            // Check if chat node already exists (and filter out all existing chat-responses)
            const chatId = `chat-response-${nodeId}`;
            const otherNodesFiltered = nodes.filter(
              (n) => n.type !== "chat-response",
            );

            // Create new chat-response node
            const chatNode: WorkspaceNode = {
              id: chatId,
              name: "Assistant Chat",
              type: "chat-response",
              spec: null,
              genuiSpec: null,
              content: "ok lets chat about this",
              x: newX + newWidth + 20,
              y: newY,
              width: 350,
              height: newHeight,
              isMinimized: false,
              isMaximized: false,
            };

            // Push all other nodes (except the target node and the new chat node) out of the way
            const safeDist = 650;
            const updatedNodes = otherNodesFiltered.map((n) => {
              if (n.id === nodeId) {
                return {
                  ...n,
                  x: newX,
                  y: newY,
                  width: newWidth,
                  height: newHeight,
                  isMinimized: false,
                  isMaximized: false,
                };
              }

              // Calculate distance from expanded center
              const nCx = n.x + n.width / 2;
              const nCy = n.y + n.height / 2;
              let dx = nCx - oldCx;
              let dy = nCy - oldCy;
              let dist = Math.sqrt(dx * dx + dy * dy);
              if (dist === 0) {
                dx = Math.random() - 0.5;
                dy = Math.random() - 0.5;
                dist = Math.sqrt(dx * dx + dy * dy);
              }
              const ux = dx / dist;
              const uy = dy / dist;

              if (dist < safeDist) {
                const pushAmount = safeDist - dist;
                return {
                  ...n,
                  x: n.x + ux * pushAmount,
                  y: n.y + uy * pushAmount,
                };
              }
              return n;
            });

            return {
              ...v,
              nodes: [...updatedNodes, chatNode],
            };
          });

          return { views: nextViews };
        });

        // Trigger input glow pulse twice
        set({ inputGlowActive: true });
        setTimeout(() => {
          set({ inputGlowActive: false });
        }, 1600);

        // Disappear after a few seconds
        const chatId = `chat-response-${nodeId}`;
        setTimeout(() => {
          set((state) => {
            const nextViews = state.views.map((v) => {
              if (v.id !== tabId) return v;
              return {
                ...v,
                nodes: (v.nodes || []).filter((n) => n.id !== chatId),
              };
            });
            return { views: nextViews };
          });
        }, 8000);
      },

      setAssistantPanelOpen: (open) => set({ assistantPanelOpen: open }),

      updateViewGenuiSpec: (id, genuiSpec) => {
        set((state) => ({
          views: state.views.map((v) => {
            const nodes = v.nodes || [];
            const hasNode = nodes.some((n) => n.id === id);
            if (!hasNode) return v;
            return {
              ...v,
              nodes: nodes.map((n) => (n.id === id ? { ...n, genuiSpec } : n)),
            };
          }),
        }));
      },

      updateNodeSpec: (nodeId, spec) => {
        set((state) => ({
          views: state.views.map((v) => {
            const nodes = v.nodes || [];
            const hasNode = nodes.some((n) => n.id === nodeId);
            if (!hasNode) return v;
            return {
              ...v,
              nodes: nodes.map((n) => (n.id === nodeId ? { ...n, spec } : n)),
            };
          }),
        }));
      },

      handleAssistantResponse: (text, spec, prompt) => {
        let _createdChatNodeId: string | null = null;
        let _tabIdToClean: string | null = null;

        set((state) => {
          const nextViews = [...state.views];
          let activeId = state.activeViewId;

          let activeTab = nextViews.find((v) => v.id === activeId);
          if (!activeTab) {
            activeId = crypto.randomUUID();
            const { name: tabName } = deriveViewTypeAndName(prompt);
            activeTab = {
              id: activeId,
              name: tabName || "Workspace",
              nodes: [],
              panX: 0,
              panY: 0,
            };
            nextViews.push(activeTab);
          } else if (!activeTab.nodes) {
            activeTab.nodes = [];
            activeTab.panX = 0;
            activeTab.panY = 0;
          }

          let componentNodeId: string | null = null;
          let updatedNodes = activeTab.nodes.filter(
            (n) => n.type !== "chat-response",
          );

          if (spec) {
            componentNodeId = crypto.randomUUID();
            const { name, type } = deriveViewTypeAndName(prompt);
            const count = updatedNodes.length;
            const newNode: WorkspaceNode = {
              id: componentNodeId,
              name,
              type,
              spec,
              genuiSpec: null,
              x: 100 + count * 40,
              y: 100 + count * 40,
              width: 420,
              height: 480,
              isMinimized: false,
              isMaximized: false,
            };
            updatedNodes.push(newNode);
          }

          if (text) {
            const chatNodeId = crypto.randomUUID();
            _createdChatNodeId = chatNodeId;
            _tabIdToClean = activeId;
            const count = updatedNodes.length;
            let chatNode: WorkspaceNode;

            if (componentNodeId) {
              const compNodeIdx = updatedNodes.findIndex(
                (n) => n.id === componentNodeId,
              );
              const compNode = updatedNodes[compNodeIdx];

              chatNode = {
                id: chatNodeId,
                name: "Assistant Chat",
                type: "chat-response",
                spec: null,
                genuiSpec: null,
                content: text,
                x: compNode.x + compNode.width + 20,
                y: compNode.y,
                width: 350,
                height: compNode.height,
                isMinimized: false,
                isMaximized: false,
              };

              const oldCx = compNode.x + compNode.width / 2;
              const oldCy = compNode.y + compNode.height / 2;
              const safeDist = 650;

              updatedNodes = updatedNodes.map((n) => {
                if (n.id === componentNodeId) return n;

                const nCx = n.x + n.width / 2;
                const nCy = n.y + n.height / 2;
                let dx = nCx - oldCx;
                let dy = nCy - oldCy;
                let dist = Math.sqrt(dx * dx + dy * dy);
                if (dist === 0) {
                  dx = Math.random() - 0.5;
                  dy = Math.random() - 0.5;
                  dist = Math.sqrt(dx * dx + dy * dy);
                }
                const ux = dx / dist;
                const uy = dy / dist;

                if (dist < safeDist) {
                  const pushAmount = safeDist - dist;
                  return {
                    ...n,
                    x: n.x + ux * pushAmount,
                    y: n.y + uy * pushAmount,
                  };
                }
                return n;
              });
            } else {
              chatNode = {
                id: chatNodeId,
                name: "Assistant Chat",
                type: "chat-response",
                spec: null,
                genuiSpec: null,
                content: text,
                x: 150 + count * 40,
                y: 150 + count * 40,
                width: 350,
                height: 300,
                isMinimized: false,
                isMaximized: false,
              };
            }
            updatedNodes.push(chatNode);
          }

          activeTab.nodes = updatedNodes;

          return {
            views: nextViews,
            activeViewId: activeId,
            canvasMode: "viewing" as CanvasMode,
          };
        });

        // Trigger input glow pulse twice
        set({ inputGlowActive: true });
        setTimeout(() => {
          set({ inputGlowActive: false });
        }, 1600);
      },

      // Compatibility no-ops
      minimizeView: (_id, _minimized) => {},
      maximizeView: (_id, _maximized) => {},
      setSplitSide: (_id, _side) => {},

      // ── Usage tracking ──
      trackAction: (actionId) =>
        set((s) => ({
          actionUsage: {
            ...s.actionUsage,
            [actionId]: {
              count: (s.actionUsage[actionId]?.count ?? 0) + 1,
              lastUsed: Date.now(),
            },
          },
        })),

      getTopActions: (n = 5) => {
        const { actionUsage } = get();
        return Object.entries(actionUsage)
          .sort(([, a], [, b]) => b.count - a.count)
          .slice(0, n)
          .map(([id]) => id);
      },
    }),
    {
      name: "eliza-cloud-canvas",
      // Bumped to 1 to drop any stale persisted `defaultUiMode: "canvas"` so the
      // classic dashboard becomes the default surface for existing users too
      // (not just fresh sessions). The canvas remains available via the toggle.
      version: 1,
      migrate: (persisted, version) => {
        const state = (persisted ?? {}) as Partial<CanvasState>;
        if (version < 1) {
          state.defaultUiMode = "classic";
        }
        return state as CanvasState;
      },
      partialize: (state) => ({
        savedViews: state.savedViews,
        actionUsage: state.actionUsage,
        sessionCount: state.sessionCount,
        lastCanvasOpen: state.lastCanvasOpen,
        views: state.views,
        activeViewId: state.activeViewId,
        snapshots: state.snapshots,
        defaultUiMode: state.defaultUiMode,
      }),
    },
  ),
);

export function deriveViewTypeAndName(prompt: string): {
  type: string;
  name: string;
} {
  const p = prompt.toLowerCase();

  const rules = [
    {
      type: "adminInfrastructure",
      name: "admin infrastructure",
      keywords: ["infrastructure", "infra", "warm pool", "node pool"],
    },
    {
      type: "adminRpc",
      name: "rpc status",
      keywords: ["rpc", "wallet status"],
    },
    {
      type: "adminMetrics",
      name: "admin metrics",
      keywords: ["metric", "retention", "dau", "mau", "growth"],
    },
    {
      type: "securityPermissions",
      name: "permissions matrix",
      keywords: [
        "permission",
        "grant",
        "access level",
        "revoke",
        "plugin grant",
      ],
    },
    {
      type: "documents",
      name: "knowledge",
      keywords: ["document", "file", "knowledge", "upload", "vector"],
    },
    { type: "agents", name: "agents", keywords: ["agent", "character", "bot"] },
    {
      type: "billing",
      name: "billing",
      keywords: ["billing", "credit", "balance", "invoice", "transaction"],
    },
    { type: "apikeys", name: "api keys", keywords: ["key", "token"] },
    {
      type: "analytics",
      name: "analytics",
      keywords: ["analytics", "usage stats", "cost", "spending"],
    },
    {
      type: "security",
      name: "security",
      keywords: ["security", "mfa", "2fa", "totp"],
    },
    {
      type: "connectors",
      name: "connectors",
      keywords: [
        "connector",
        "integration",
        "telegram",
        "discord",
        "whatsapp",
        "slack",
      ],
    },
    {
      type: "mcps",
      name: "mcp servers",
      keywords: ["mcp", "model context protocol"],
    },
    {
      type: "containers",
      name: "containers",
      keywords: ["container", "docker", "image"],
    },
    { type: "domains", name: "domains", keywords: ["domain", "dns", "ssl"] },
    {
      type: "remotePairing",
      name: "remote pairing",
      keywords: ["pair", "remote", "sync", "electric sql"],
    },
    {
      type: "earnings",
      name: "earnings",
      keywords: ["earning", "reward", "revenue", "payout"],
    },
    {
      type: "profile",
      name: "profile",
      keywords: ["profile", "account", "settings"],
    },
    {
      type: "health",
      name: "health",
      keywords: ["health", "uptime", "api-explorer"],
    },
    {
      type: "admin",
      name: "admin panel",
      keywords: ["admin panel", "admin overview", "moderation"],
    },
  ];

  for (const rule of rules) {
    if (rule.keywords.some((k) => p.includes(k))) {
      return { type: rule.type, name: rule.name };
    }
  }

  const slug = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 30);
  return { type: "custom", name: slug || "workspace" };
}
