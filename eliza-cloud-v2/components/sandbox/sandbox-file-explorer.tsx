"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import Editor, { Monaco } from "@monaco-editor/react";
import type * as monacoEditor from "monaco-editor";
import {
  ChevronRight,
  ChevronDown,
  File,
  Folder,
  FolderOpen,
  Save,
  RefreshCw,
  Loader2,
  X,
  Circle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

interface FileTreeNode {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: FileTreeNode[];
}

interface SandboxFileExplorerProps {
  sessionId: string;
  className?: string;
}

// ============================================================================
// File Cache - Global cache for file contents and tree across component mounts
// ============================================================================

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

interface FileCache {
  trees: Map<string, CacheEntry<FileTreeNode[]>>;
  files: Map<string, CacheEntry<string>>;
}

// Global cache persists across component remounts within the same session
const globalFileCache: FileCache = {
  trees: new Map(),
  files: new Map(),
};

// Cache TTL: 5 minutes for file tree, 10 minutes for file content
const TREE_CACHE_TTL_MS = 5 * 60 * 1000;
const FILE_CACHE_TTL_MS = 10 * 60 * 1000;

function getCacheKey(sessionId: string, path?: string): string {
  return path ? `${sessionId}:${path}` : sessionId;
}

function isValidCache<T>(
  entry: CacheEntry<T> | undefined,
  ttlMs: number,
): entry is CacheEntry<T> {
  if (!entry) return false;
  return Date.now() - entry.timestamp < ttlMs;
}

function getTreeFromCache(sessionId: string): FileTreeNode[] | null {
  const key = getCacheKey(sessionId);
  const entry = globalFileCache.trees.get(key);
  if (isValidCache(entry, TREE_CACHE_TTL_MS)) {
    return entry.data;
  }
  return null;
}

function setTreeInCache(sessionId: string, tree: FileTreeNode[]): void {
  const key = getCacheKey(sessionId);
  globalFileCache.trees.set(key, { data: tree, timestamp: Date.now() });
}

function getFileFromCache(sessionId: string, path: string): string | null {
  const key = getCacheKey(sessionId, path);
  const entry = globalFileCache.files.get(key);
  if (isValidCache(entry, FILE_CACHE_TTL_MS)) {
    return entry.data;
  }
  return null;
}

function setFileInCache(
  sessionId: string,
  path: string,
  content: string,
): void {
  const key = getCacheKey(sessionId, path);
  globalFileCache.files.set(key, { data: content, timestamp: Date.now() });
}

function invalidateFileInCache(sessionId: string, path: string): void {
  const key = getCacheKey(sessionId, path);
  globalFileCache.files.delete(key);
}

function invalidateTreeCache(sessionId: string): void {
  const key = getCacheKey(sessionId);
  globalFileCache.trees.delete(key);
}

// File extension to language mapping
const getLanguageFromPath = (path: string): string => {
  const ext = path.split(".").pop()?.toLowerCase() || "";
  const langMap: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    json: "json",
    md: "markdown",
    css: "css",
    scss: "scss",
    less: "less",
    html: "html",
    xml: "xml",
    yaml: "yaml",
    yml: "yaml",
    py: "python",
    rs: "rust",
    go: "go",
    sh: "shell",
    bash: "shell",
    sql: "sql",
    graphql: "graphql",
    svg: "xml",
    txt: "plaintext",
  };
  return langMap[ext] || "plaintext";
};

// Get file icon color based on extension
const getFileColor = (name: string): string => {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  const colorMap: Record<string, string> = {
    ts: "text-blue-400",
    tsx: "text-blue-400",
    js: "text-yellow-400",
    jsx: "text-yellow-400",
    json: "text-yellow-600",
    md: "text-white/60",
    css: "text-purple-400",
    scss: "text-pink-400",
    html: "text-orange-400",
    svg: "text-orange-400",
    py: "text-green-400",
    rs: "text-orange-500",
    go: "text-cyan-400",
  };
  return colorMap[ext] || "text-white/40";
};

interface OpenFile {
  path: string;
  content: string;
  originalContent: string;
  language: string;
}

export function SandboxFileExplorer({
  sessionId,
  className,
}: SandboxFileExplorerProps) {
  const [tree, setTree] = useState<FileTreeNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [openFiles, setOpenFiles] = useState<OpenFile[]>([]);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [loadingFile, setLoadingFile] = useState<string | null>(null);
  const editorRef = useRef<monacoEditor.editor.IStandaloneCodeEditor | null>(
    null,
  );

  // Fetch file tree with caching
  const fetchFileTree = useCallback(
    async (forceRefresh = false) => {
      // Check cache first (unless forced refresh)
      if (!forceRefresh) {
        const cachedTree = getTreeFromCache(sessionId);
        if (cachedTree) {
          setTree(cachedTree);
          setLoading(false);
          // Auto-expand src directory for cached data too
          setExpandedDirs((prev) => {
            const next = new Set(prev);
            next.add("./src");
            next.add("./src/app");
            return next;
          });
          return;
        }
      }

      setLoading(true);
      try {
        const res = await fetch(
          `/api/v1/app-builder/sessions/${sessionId}/files?path=.`,
          { credentials: "include" },
        );
        const data = await res.json();
        if (data.success) {
          const treeData = data.tree || [];
          setTree(treeData);
          // Cache the tree data
          setTreeInCache(sessionId, treeData);
          // Auto-expand src directory
          setExpandedDirs((prev) => {
            const next = new Set(prev);
            next.add("./src");
            next.add("./src/app");
            return next;
          });
        }
      } catch (error) {
        console.warn("[SandboxFileExplorer] Failed to fetch file tree:", error);
        toast.error("Failed to load files");
      } finally {
        setLoading(false);
      }
    },
    [sessionId],
  );

  useEffect(() => {
    fetchFileTree();
  }, [fetchFileTree]);

  // Open a file with caching
  const openFile = async (path: string) => {
    // Check if already open in editor tabs
    const existing = openFiles.find((f) => f.path === path);
    if (existing) {
      setActiveFile(path);
      return;
    }

    setLoadingFile(path);
    try {
      // Check cache first
      const cachedContent = getFileFromCache(sessionId, path);
      if (cachedContent !== null) {
        const newFile: OpenFile = {
          path,
          content: cachedContent,
          originalContent: cachedContent,
          language: getLanguageFromPath(path),
        };
        setOpenFiles((prev) => [...prev, newFile]);
        setActiveFile(path);
        setLoadingFile(null);
        return;
      }

      // Fetch from API (uses native sandbox.readFile internally)
      const res = await fetch(
        `/api/v1/app-builder/sessions/${sessionId}/files`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ operation: "read", path }),
        },
      );
      const data = await res.json();
      if (data.success) {
        // Cache the file content
        setFileInCache(sessionId, path, data.content);

        const newFile: OpenFile = {
          path,
          content: data.content,
          originalContent: data.content,
          language: getLanguageFromPath(path),
        };
        setOpenFiles((prev) => [...prev, newFile]);
        setActiveFile(path);
      } else {
        toast.error(data.error || "Failed to open file");
      }
    } catch (error) {
      console.warn("[SandboxFileExplorer] Failed to open file:", error);
      toast.error("Failed to open file");
    } finally {
      setLoadingFile(null);
    }
  };

  // Close a file
  const closeFile = (path: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    const file = openFiles.find((f) => f.path === path);
    if (file && file.content !== file.originalContent) {
      if (!confirm("You have unsaved changes. Close anyway?")) {
        return;
      }
    }
    setOpenFiles((prev) => prev.filter((f) => f.path !== path));
    if (activeFile === path) {
      const remaining = openFiles.filter((f) => f.path !== path);
      setActiveFile(
        remaining.length > 0 ? remaining[remaining.length - 1].path : null,
      );
    }
  };

  // Save file (uses native sandbox.writeFiles internally)
  const saveFile = useCallback(async (path: string) => {
    const file = openFiles.find((f) => f.path === path);
    if (!file) return;

    setSaving(true);
    try {
      const res = await fetch(
        `/api/v1/app-builder/sessions/${sessionId}/files`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            operation: "write",
            path,
            content: file.content,
          }),
        },
      );
      const data = await res.json();
      if (data.success) {
        // Update cache with new content
        setFileInCache(sessionId, path, file.content);

        setOpenFiles((prev) =>
          prev.map((f) =>
            f.path === path ? { ...f, originalContent: f.content } : f,
          ),
        );
        toast.success("File saved");
      } else {
        toast.error(data.error || "Failed to save file");
      }
    } catch (error) {
      console.warn("[SandboxFileExplorer] Failed to save file:", error);
      toast.error("Failed to save file");
    } finally {
      setSaving(false);
    }
  }, [openFiles, sessionId]);

  // Update file content
  const updateFileContent = (path: string, content: string) => {
    setOpenFiles((prev) =>
      prev.map((f) => (f.path === path ? { ...f, content } : f)),
    );
  };

  // Toggle directory
  const toggleDir = (path: string) => {
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        if (activeFile) {
          saveFile(activeFile);
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [activeFile, saveFile]);

  // Monaco editor setup
  const handleEditorDidMount = (
    editor: monacoEditor.editor.IStandaloneCodeEditor,
    monaco: Monaco,
  ) => {
    editorRef.current = editor;

    monaco.editor.defineTheme("sandboxTheme", {
      base: "vs-dark",
      inherit: true,
      rules: [
        { token: "comment", foreground: "6A9955" },
        { token: "keyword", foreground: "569CD6" },
        { token: "string", foreground: "CE9178" },
        { token: "number", foreground: "B5CEA8" },
        { token: "type", foreground: "4EC9B0" },
      ],
      colors: {
        "editor.background": "#0a0a0a",
        "editor.foreground": "#D4D4D4",
        "editorLineNumber.foreground": "#555555",
        "editorLineNumber.activeForeground": "#858585",
        "editor.selectionBackground": "#264F78",
        "editor.lineHighlightBackground": "#FFFFFF08",
        "editorCursor.foreground": "#FFFFFF",
        "editorIndentGuide.background": "#333333",
        "editorIndentGuide.activeBackground": "#555555",
      },
    });

    monaco.editor.setTheme("sandboxTheme");
  };

  const activeOpenFile = openFiles.find((f) => f.path === activeFile);
  const hasUnsavedChanges = activeOpenFile
    ? activeOpenFile.content !== activeOpenFile.originalContent
    : false;

  // Render file tree node
  const renderNode = (node: FileTreeNode, depth: number = 0) => {
    const isExpanded = expandedDirs.has(node.path);
    const isActive = activeFile === node.path;
    const isLoading = loadingFile === node.path;

    if (node.type === "directory") {
      return (
        <div key={node.path}>
          <button
            onClick={() => toggleDir(node.path)}
            className={cn(
              "w-full flex items-center gap-1 py-1 px-2 text-xs hover:bg-white/5 transition-colors",
              "text-white/70 hover:text-white",
            )}
            style={{ paddingLeft: `${depth * 12 + 8}px` }}
          >
            {isExpanded ? (
              <ChevronDown className="h-3 w-3 shrink-0 text-white/40" />
            ) : (
              <ChevronRight className="h-3 w-3 shrink-0 text-white/40" />
            )}
            {isExpanded ? (
              <FolderOpen className="h-3.5 w-3.5 shrink-0 text-amber-400/80" />
            ) : (
              <Folder className="h-3.5 w-3.5 shrink-0 text-amber-400/60" />
            )}
            <span className="truncate">{node.name}</span>
          </button>
          {isExpanded && node.children && (
            <div>
              {node.children.map((child) => renderNode(child, depth + 1))}
            </div>
          )}
        </div>
      );
    }

    return (
      <button
        key={node.path}
        onClick={() => openFile(node.path)}
        className={cn(
          "w-full flex items-center gap-1.5 py-1 px-2 text-xs transition-colors",
          isActive
            ? "bg-white/10 text-white"
            : "text-white/60 hover:bg-white/5 hover:text-white/80",
        )}
        style={{ paddingLeft: `${depth * 12 + 20}px` }}
        disabled={isLoading}
      >
        {isLoading ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-white/40" />
        ) : (
          <File
            className={cn("h-3.5 w-3.5 shrink-0", getFileColor(node.name))}
          />
        )}
        <span className="truncate">{node.name}</span>
      </button>
    );
  };

  return (
    <div className={cn("flex h-full bg-[#0a0a0a]", className)}>
      {/* File Tree Sidebar */}
      <div className="w-56 border-r border-white/10 flex flex-col">
        <div className="flex items-center justify-between px-3 py-2 border-b border-white/10">
          <span className="text-[10px] font-semibold text-white/50 uppercase tracking-wider">
            Explorer
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="h-5 w-5"
            onClick={() => {
              // Invalidate cache and force refresh
              invalidateTreeCache(sessionId);
              fetchFileTree(true);
            }}
            disabled={loading}
            title="Refresh files (clears cache)"
          >
            <RefreshCw
              className={cn("h-3 w-3 text-white/50", loading && "animate-spin")}
            />
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto py-1">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-white/30" />
            </div>
          ) : tree.length === 0 ? (
            <div className="px-3 py-4 text-center text-white/30 text-xs">
              No files found
            </div>
          ) : (
            tree.map((node) => renderNode(node))
          )}
        </div>
      </div>

      {/* Editor Area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Tab Bar */}
        {openFiles.length > 0 && (
          <div className="flex items-center border-b border-white/10 bg-black/20 overflow-x-auto">
            {openFiles.map((file) => {
              const isActive = activeFile === file.path;
              const hasChanges = file.content !== file.originalContent;
              const fileName = file.path.split("/").pop() || file.path;

              return (
                <button
                  key={file.path}
                  onClick={() => setActiveFile(file.path)}
                  className={cn(
                    "group flex items-center gap-1.5 px-3 py-1.5 text-xs border-r border-white/5 min-w-0",
                    isActive
                      ? "bg-[#0a0a0a] text-white"
                      : "bg-black/20 text-white/50 hover:text-white/70",
                  )}
                >
                  <File
                    className={cn("h-3 w-3 shrink-0", getFileColor(fileName))}
                  />
                  <span className="truncate max-w-[120px]">{fileName}</span>
                  {hasChanges && (
                    <Circle className="h-2 w-2 fill-current text-white/60 shrink-0" />
                  )}
                  <button
                    onClick={(e) => closeFile(file.path, e)}
                    className="opacity-0 group-hover:opacity-100 hover:bg-white/10 rounded p-0.5 -mr-1 transition-opacity"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </button>
              );
            })}
            {/* Save button */}
            {activeFile && hasUnsavedChanges && (
              <Button
                variant="ghost"
                size="sm"
                className="ml-auto mr-2 h-6 text-xs gap-1.5"
                onClick={() => saveFile(activeFile)}
                disabled={saving}
              >
                {saving ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Save className="h-3 w-3" />
                )}
                Save
              </Button>
            )}
          </div>
        )}

        {/* Editor */}
        <div className="flex-1">
          {activeOpenFile ? (
            <Editor
              height="100%"
              language={activeOpenFile.language}
              value={activeOpenFile.content}
              onChange={(value) =>
                updateFileContent(activeOpenFile.path, value || "")
              }
              onMount={handleEditorDidMount}
              options={{
                fontSize: 13,
                fontFamily:
                  '"SF Mono", "Monaco", "Menlo", "Ubuntu Mono", monospace',
                lineHeight: 20,
                tabSize: 2,
                insertSpaces: true,
                minimap: { enabled: false },
                scrollBeyondLastLine: false,
                automaticLayout: true,
                smoothScrolling: true,
                cursorBlinking: "smooth",
                cursorSmoothCaretAnimation: "on",
                renderLineHighlight: "line",
                folding: true,
                foldingStrategy: "indentation",
                showFoldingControls: "mouseover",
                padding: { top: 12, bottom: 12 },
                glyphMargin: false,
                lineNumbers: "on",
                lineNumbersMinChars: 4,
                scrollbar: {
                  useShadows: false,
                  verticalScrollbarSize: 8,
                  horizontalScrollbarSize: 8,
                },
              }}
            />
          ) : (
            <div className="flex items-center justify-center h-full text-white/20">
              <div className="text-center">
                <File className="h-12 w-12 mx-auto mb-3 opacity-30" />
                <p className="text-sm">Select a file to edit</p>
                <p className="text-xs mt-1 text-white/10">
                  Browse files in the explorer
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
