import { create } from "zustand";
import { nanoid } from "nanoid";

export type FileViewMode = "view" | "edit" | "diff";

export interface DiffData {
  oldContent: string;
  newContent: string;
  oldPath?: string;
}

export interface FileTab {
  id: string;
  path: string;
  filename: string;
  content: string;
  originalContent: string;
  isDirty: boolean;
  language: string;
  mode: FileViewMode;
  diff?: DiffData;
  isImage: boolean;
}

interface FileViewerState {
  isOpen: boolean;
  tabs: FileTab[];
  activeTabId: string | null;
  panelWidth: number;

  openFile: (path: string, content: string) => void;
  openDiff: (path: string, oldContent: string, newContent: string) => void;
  loadAndOpen: (path: string) => Promise<void>;
  closeTab: (tabId: string) => void;
  closeAllTabs: () => void;
  setActiveTab: (tabId: string) => void;
  updateContent: (tabId: string, content: string) => void;
  setMode: (tabId: string, mode: FileViewMode) => void;
  markSaved: (tabId: string) => void;
  setPanelWidth: (width: number) => void;
  setOpen: (open: boolean) => void;
}

const IMAGE_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "ico",
]);

export function isImageFile(filePath: string): boolean {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXTENSIONS.has(ext);
}

export function detectLanguage(filePath: string): string {
  const filename = filePath.split("/").pop()?.toLowerCase() ?? "";
  if (filename === "dockerfile") return "dockerfile";
  if (filename === "makefile" || filename === "gnumakefile") return "makefile";

  const ext = filename.split(".").pop() ?? "";
  const map: Record<string, string> = {
    ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx",
    mjs: "javascript", cjs: "javascript",
    py: "python", rs: "rust", go: "go",
    css: "css", scss: "scss", less: "less",
    html: "html", htm: "html",
    json: "json", jsonc: "json",
    md: "markdown", mdx: "markdown",
    sh: "bash", bash: "bash", zsh: "bash",
    yml: "yaml", yaml: "yaml",
    toml: "toml", sql: "sql",
    graphql: "graphql", gql: "graphql",
    rb: "ruby", java: "java",
    c: "c", cpp: "cpp", cc: "cpp", cxx: "cpp",
    h: "c", hpp: "cpp",
    cs: "csharp", php: "php",
    swift: "swift", kt: "kotlin",
    r: "r", scala: "scala",
    ex: "elixir", exs: "elixir",
    vue: "vue", svelte: "svelte",
    xml: "xml",
  };
  return map[ext] ?? "text";
}

function getFilename(filePath: string): string {
  return filePath.split("/").pop() ?? filePath;
}

export const useFileViewerStore = create<FileViewerState>()((set, get) => ({
  isOpen: false,
  tabs: [],
  activeTabId: null,
  panelWidth: 520,

  openFile: (path, content) => {
    const { tabs } = get();
    const existing = tabs.find((t) => t.path === path && !t.diff);
    if (existing) {
      set({ activeTabId: existing.id, isOpen: true });
      return;
    }
    const id = nanoid();
    const tab: FileTab = {
      id,
      path,
      filename: getFilename(path),
      content,
      originalContent: content,
      isDirty: false,
      language: detectLanguage(path),
      mode: "view",
      isImage: isImageFile(path),
    };
    set((state) => ({
      tabs: [...state.tabs, tab],
      activeTabId: id,
      isOpen: true,
    }));
  },

  openDiff: (path, oldContent, newContent) => {
    const id = nanoid();
    const tab: FileTab = {
      id,
      path,
      filename: getFilename(path),
      content: newContent,
      originalContent: oldContent,
      isDirty: false,
      language: detectLanguage(path),
      mode: "diff",
      diff: { oldContent, newContent },
      isImage: false,
    };
    set((state) => ({
      tabs: [...state.tabs, tab],
      activeTabId: id,
      isOpen: true,
    }));
  },

  loadAndOpen: async (path) => {
    const { tabs } = get();
    const existing = tabs.find((t) => t.path === path && !t.diff);
    if (existing) {
      set({ activeTabId: existing.id, isOpen: true });
      return;
    }
    try {
      const res = await fetch(`/api/files/read?path=${encodeURIComponent(path)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      get().openFile(path, data.content ?? "");
    } catch (err) {
      console.error("Failed to load file:", path, err);
    }
  },

  closeTab: (tabId) => {
    set((state) => {
      const tabs = state.tabs.filter((t) => t.id !== tabId);
      const activeTabId =
        state.activeTabId === tabId
          ? (tabs[tabs.length - 1]?.id ?? null)
          : state.activeTabId;
      return { tabs, activeTabId, isOpen: tabs.length > 0 };
    });
  },

  closeAllTabs: () => {
    set({ tabs: [], activeTabId: null, isOpen: false });
  },

  setActiveTab: (tabId) => {
    set({ activeTabId: tabId });
  },

  updateContent: (tabId, content) => {
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.id === tabId
          ? { ...t, content, isDirty: content !== t.originalContent }
          : t
      ),
    }));
  },

  setMode: (tabId, mode) => {
    set((state) => ({
      tabs: state.tabs.map((t) => (t.id === tabId ? { ...t, mode } : t)),
    }));
  },

  markSaved: (tabId) => {
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.id === tabId
          ? { ...t, isDirty: false, originalContent: t.content }
          : t
      ),
    }));
  },

  setPanelWidth: (width) => {
    set({ panelWidth: Math.max(300, Math.min(width, 1400)) });
  },

  setOpen: (open) => {
    set({ isOpen: open });
  },
}));
