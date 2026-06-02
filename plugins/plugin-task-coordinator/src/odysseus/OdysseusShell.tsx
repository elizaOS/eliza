// OdysseusShell — root of the odysseus port (Phase 1: shell + chat/streaming).
// Pixel-faithful odysseus chrome (icon rail + 240px sidebar + chat container)
// wired to the existing ACP task-room contracts. Registered at /odysseus so the
// live /orchestrator workbench keeps working while this is iterated; it becomes
// /orchestrator once approved.
//
// Theming: themeVars(name) is applied inline on the root (the active odysseus
// preset's palette + remapped eliza semantic tokens, so reused components
// inherit the look); ODYSSEUS_CSS structural rules are injected via a <style>
// tag. No .css import, keeping the plugin's Node-side view manifest import safe.

import type { CodingAgentTaskThread } from "@elizaos/ui";
import { client } from "@elizaos/ui";
import {
  type PointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { BgEffect } from "./BgEffect";
import { ChatContainer } from "./ChatContainer";
import { useChatSubmit } from "./hooks/useChatSubmit";
import { useTaskRoom } from "./hooks/useTaskRoom";
import { IconRail } from "./IconRail";
import { MemoryPanel } from "./MemoryPanel";
import { NotesPanel } from "./NotesPanel";
import {
  buildThemeVars,
  FONT_MAP,
  ODYSSEUS_CSS,
  ODYSSEUS_THEMES,
  type ThemeDensity,
  type ThemeFont,
  type ThemeName,
  type ThemePalette,
  themeVars,
} from "./odysseus-theme";
import { SearchPalette } from "./SearchPalette";
import { SessionSidebar } from "./SessionSidebar";
import { SettingsPanel } from "./SettingsPanel";
import { SkillsPanel } from "./SkillsPanel";
import { ThemeMenu } from "./ThemeMenu";
import { PREF_KEYS, readPref, writePref } from "./util/storage";

const THREAD_POLL_MS = 5_000;

export function OdysseusShell(): ReactNode {
  const [threads, setThreads] = useState<CodingAgentTaskThread[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() =>
    readPref<boolean>(PREF_KEYS.sidebarCollapsed, false),
  );
  const [sidebarWidth, setSidebarWidth] = useState<number>(() =>
    readPref<number>(PREF_KEYS.sidebarWidth, 240),
  );
  const widthRef = useRef(sidebarWidth);
  widthRef.current = sidebarWidth;
  const [searchOpen, setSearchOpen] = useState(false);
  const [themeName, setThemeName] = useState<ThemeName>(() =>
    readPref<ThemeName>(PREF_KEYS.themeMode, "dark"),
  );
  const [themeMenuOpen, setThemeMenuOpen] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const [font, setFont] = useState<ThemeFont>(() =>
    readPref<ThemeFont>(PREF_KEYS.font, "mono"),
  );
  const [density, setDensity] = useState<ThemeDensity>(() =>
    readPref<ThemeDensity>(PREF_KEYS.density, "comfortable"),
  );
  const [customColors, setCustomColors] = useState<ThemePalette>(() =>
    readPref<ThemePalette>(PREF_KEYS.customTheme, ODYSSEUS_THEMES.dark),
  );
  const [bgPattern, setBgPattern] = useState<string>(() =>
    readPref<string>(PREF_KEYS.bgPattern, "none"),
  );
  const [customThemes, setCustomThemes] = useState<
    Record<string, ThemePalette>
  >(() => readPref<Record<string, ThemePalette>>(PREF_KEYS.customThemes, {}));
  const [pinnedIds, setPinnedIds] = useState<string[]>(() =>
    readPref<string[]>(PREF_KEYS.pinnedThreads, []),
  );

  const refreshThreads = useCallback(async () => {
    const next = await client
      .listCodingAgentTaskThreads({ limit: 100 })
      .catch(() => null);
    if (next) setThreads(next);
  }, []);

  useEffect(() => {
    void refreshThreads();
    const timer = window.setInterval(
      () => void refreshThreads(),
      THREAD_POLL_MS,
    );
    return () => window.clearInterval(timer);
  }, [refreshThreads]);

  const { detail, conversation, isActive } = useTaskRoom(selectedId);

  const activeSessionId = useMemo(() => {
    const session = (detail?.sessions ?? []).find((s) => s.stoppedAt == null);
    return session?.sessionId ?? null;
  }, [detail?.sessions]);

  const onCreated = useCallback(
    (id: string) => {
      setSelectedId(id);
      void refreshThreads();
    },
    [refreshThreads],
  );

  const { input, setInput, sending, submit, stop } = useChatSubmit({
    selectedId,
    activeSessionId,
    onCreated,
  });

  const onNewChat = useCallback(() => setSelectedId(null), []);

  const openPanel = useCallback(
    (panel: "theme" | "memory" | "skills" | "notes" | "settings") => {
      if (panel === "theme") setThemeMenuOpen(true);
      else if (panel === "memory") setMemoryOpen(true);
      else if (panel === "skills") setSkillsOpen(true);
      else if (panel === "notes") setNotesOpen(true);
      else setSettingsOpen(true);
    },
    [],
  );

  const onRenameThread = useCallback(
    (id: string, title: string) => {
      void client
        .updateOrchestratorTask(id, { title })
        .then(() => refreshThreads())
        .catch(() => {});
    },
    [refreshThreads],
  );

  const onDeleteThread = useCallback(
    (id: string) => {
      void client
        .deleteOrchestratorTask(id)
        .then(() => {
          setSelectedId((cur) => (cur === id ? null : cur));
          return refreshThreads();
        })
        .catch(() => {});
    },
    [refreshThreads],
  );

  // Pin/unpin a thread (odysseus star): pinned threads sort to the top of the
  // Chats list and persist across reloads (client-only, localStorage-backed).
  const onTogglePin = useCallback((id: string) => {
    setPinnedIds((prev) => {
      const next = prev.includes(id)
        ? prev.filter((p) => p !== id)
        : [...prev, id];
      writePref(PREF_KEYS.pinnedThreads, next);
      return next;
    });
  }, []);

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((prev) => {
      writePref(PREF_KEYS.sidebarCollapsed, !prev);
      return !prev;
    });
  }, []);

  // Drag-to-resize the sidebar (odysseus .sidebar-resize-handle). Pointer move
  // updates width live (clamped 180–440px); the final width persists on release.
  const startResize = useCallback((e: PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = widthRef.current;
    const onMove = (ev: globalThis.PointerEvent) => {
      setSidebarWidth(
        Math.max(180, Math.min(440, startW + (ev.clientX - startX))),
      );
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      writePref(PREF_KEYS.sidebarWidth, widthRef.current);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, []);

  const pickTheme = useCallback((name: ThemeName) => {
    writePref(PREF_KEYS.themeMode, name);
    setThemeName(name);
  }, []);

  const pickFont = useCallback((next: ThemeFont) => {
    writePref(PREF_KEYS.font, next);
    setFont(next);
  }, []);

  const pickDensity = useCallback((next: ThemeDensity) => {
    writePref(PREF_KEYS.density, next);
    setDensity(next);
  }, []);

  const pickBg = useCallback((next: string) => {
    writePref(PREF_KEYS.bgPattern, next);
    setBgPattern(next);
  }, []);

  const saveCustomTheme = useCallback(
    (name: string) => {
      setCustomThemes((prev) => {
        if (!prev[name] && Object.keys(prev).length >= 8) return prev;
        const next = { ...prev, [name]: customColors };
        writePref(PREF_KEYS.customThemes, next);
        return next;
      });
      writePref(PREF_KEYS.themeMode, name);
      setThemeName(name);
    },
    [customColors],
  );

  const deleteCustomTheme = useCallback((name: string) => {
    setCustomThemes((prev) => {
      const next = { ...prev };
      delete next[name];
      writePref(PREF_KEYS.customThemes, next);
      return next;
    });
    setThemeName((cur) => (cur === name ? "dark" : cur));
  }, []);

  const onCustomChange = useCallback(
    (key: "bg" | "fg" | "panel" | "border" | "red", value: string) => {
      setCustomColors((prev) => {
        const next = { ...prev, [key]: value };
        writePref(PREF_KEYS.customTheme, next);
        return next;
      });
      writePref(PREF_KEYS.themeMode, "custom");
      setThemeName("custom");
    },
    [],
  );

  // Ctrl/Cmd+K toggles the search palette (odysseus keyboard shortcut).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen((prev) => !prev);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const title = detail?.title?.trim() || "Orchestrator Chat";
  const themeStyle =
    themeName === "custom"
      ? buildThemeVars(customColors)
      : customThemes[themeName]
        ? buildThemeVars(customThemes[themeName])
        : themeVars(themeName);

  return (
    <div
      className={`odysseus-root od-density-${density}${bgPattern !== "none" ? ` od-bg-${bgPattern}` : ""}`}
      style={{ ...themeStyle, fontFamily: FONT_MAP[font] }}
      data-od-theme={themeName}
      data-testid="odysseus-shell"
    >
      {/** biome-ignore lint/security/noDangerouslySetInnerHtml: static, build-time CSS constant (no user input) */}
      <style dangerouslySetInnerHTML={{ __html: ODYSSEUS_CSS }} />
      <BgEffect pattern={bgPattern} />
      <IconRail
        onToggleSidebar={toggleSidebar}
        onOpenTheme={() => setThemeMenuOpen(true)}
        onOpenMemory={() => setMemoryOpen(true)}
        onOpenSkills={() => setSkillsOpen(true)}
        onOpenNotes={() => setNotesOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <ThemeMenu
        open={themeMenuOpen}
        current={themeName}
        onPick={pickTheme}
        onClose={() => setThemeMenuOpen(false)}
        font={font}
        density={density}
        onSetFont={pickFont}
        onSetDensity={pickDensity}
        custom={customColors}
        onCustomChange={onCustomChange}
        bgPattern={bgPattern}
        onSetBg={pickBg}
        customThemes={customThemes}
        onSaveCustom={saveCustomTheme}
        onDeleteCustom={deleteCustomTheme}
      />
      <MemoryPanel open={memoryOpen} onClose={() => setMemoryOpen(false)} />
      <SkillsPanel open={skillsOpen} onClose={() => setSkillsOpen(false)} />
      <NotesPanel open={notesOpen} onClose={() => setNotesOpen(false)} />
      <SettingsPanel
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
      />
      <SearchPalette
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        onSelect={setSelectedId}
      />
      {sidebarCollapsed ? null : (
        <SessionSidebar
          threads={threads}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onNewChat={onNewChat}
          onSearch={() => setSearchOpen(true)}
          onRename={onRenameThread}
          onDelete={onDeleteThread}
          width={sidebarWidth}
          onResizeStart={startResize}
          pinnedIds={pinnedIds}
          onTogglePin={onTogglePin}
        />
      )}
      <ChatContainer
        title={title}
        conversation={conversation}
        input={input}
        onInput={setInput}
        onSubmit={submit}
        onStop={stop}
        sending={sending}
        isActive={isActive}
        modelLabel="gpt-oss-120b"
        onNewChat={onNewChat}
        onSearch={() => setSearchOpen(true)}
        onOpenPanel={openPanel}
      />
    </div>
  );
}
