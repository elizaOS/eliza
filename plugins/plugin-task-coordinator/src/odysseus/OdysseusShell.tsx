// OdysseusShell — root of the odysseus port (shell + chat/streaming).
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
import { AdminView } from "./AdminView";
import { BgEffect } from "./BgEffect";
import { CalendarView } from "./CalendarView";
import { ChatContainer } from "./ChatContainer";
import { CompareView } from "./CompareView";
import { CookbookView } from "./CookbookView";
import { DocumentLibraryView } from "./DocumentLibraryView";
import { EmailView } from "./EmailView";
import { GalleryEditorView } from "./GalleryEditorView";
import { GalleryView } from "./GalleryView";
import { GroupChatView } from "./GroupChatView";
import { useChatSubmit } from "./hooks/useChatSubmit";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { useTaskRoom } from "./hooks/useTaskRoom";
import { IconRail } from "./IconRail";
import { MemoryPanel } from "./MemoryPanel";
import { MinimizedDock } from "./MinimizedDock";
import { ModelsView } from "./ModelsView";
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
import { PresetsPanel } from "./PresetsPanel";
import { ResearchView } from "./ResearchView";
import { SearchPalette } from "./SearchPalette";
import { SessionSidebar } from "./SessionSidebar";
import { SettingsPanel } from "./SettingsPanel";
import { SkillsPanel } from "./SkillsPanel";
import { TasksView } from "./TasksView";
import { ThemeMenu } from "./ThemeMenu";
import { PREF_KEYS, readPref, writePref } from "./util/storage";
import { VoiceView } from "./VoiceView";
import { WindowManagerProvider } from "./WindowManager";

const THREAD_POLL_MS = 5_000;

// odysseus sidebar-layout.js AUTO_COLLAPSE_WIDTH: below this viewport width the
// sidebar stops being an in-flow, drag-resizable panel and becomes an overlay
// drawer that slides in over the chat with a tap-to-close backdrop.
const MOBILE_BREAKPOINT = 700;

// Feature-launch ids shared between the icon rail (collapsed state) and the
// expanded sidebar's labeled rows. Each maps 1:1 to an existing view setter in
// the shell (see openTool); the sidebar imports this type to type its handler.
export type ToolId =
  | "theme"
  | "memory"
  | "skills"
  | "notes"
  | "settings"
  | "compare"
  | "research"
  | "docs"
  | "calendar"
  | "email"
  | "gallery"
  | "cookbook"
  | "models"
  | "tasks"
  | "editor"
  | "group"
  | "admin"
  | "voice"
  | "presets";

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
  // Mobile flag (odysseus sidebar-layout.js): below MOBILE_BREAKPOINT the
  // sidebar becomes an overlay drawer. Initialised from the current viewport so
  // a first paint at a narrow width starts collapsed.
  const [isMobile, setIsMobile] = useState(
    () =>
      typeof window !== "undefined" && window.innerWidth < MOBILE_BREAKPOINT,
  );
  const [searchOpen, setSearchOpen] = useState(false);
  const [themeName, setThemeName] = useState<ThemeName>(() =>
    readPref<ThemeName>(PREF_KEYS.themeMode, "dark"),
  );
  const [themeMenuOpen, setThemeMenuOpen] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const [compareOpen, setCompareOpen] = useState(false);
  const [researchOpen, setResearchOpen] = useState(false);
  const [docsOpen, setDocsOpen] = useState(false);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [emailOpen, setEmailOpen] = useState(false);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [cookbookOpen, setCookbookOpen] = useState(false);
  const [modelsOpen, setModelsOpen] = useState(false);
  const [tasksOpen, setTasksOpen] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [groupOpen, setGroupOpen] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [presetsOpen, setPresetsOpen] = useState(false);
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

  const {
    detail,
    conversation,
    isActive,
    error: roomError,
    stale: roomStale,
    retry: retryRoom,
  } = useTaskRoom(selectedId);

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

  // Single feature-launch dispatcher shared by the icon rail and the expanded
  // sidebar's labeled rows, so both surfaces open the SAME existing panels
  // (odysseus: the rail glyphs and the sidebar tool rows target one tool each).
  // Every id maps to a real existing view setter — no fabricated panels.
  const openTool = useCallback((tool: ToolId) => {
    switch (tool) {
      case "theme":
        setThemeMenuOpen(true);
        break;
      case "memory":
        setMemoryOpen(true);
        break;
      case "skills":
        setSkillsOpen(true);
        break;
      case "notes":
        setNotesOpen(true);
        break;
      case "settings":
        setSettingsOpen(true);
        break;
      case "compare":
        setCompareOpen(true);
        break;
      case "research":
        setResearchOpen(true);
        break;
      case "docs":
        setDocsOpen(true);
        break;
      case "calendar":
        setCalendarOpen(true);
        break;
      case "email":
        setEmailOpen(true);
        break;
      case "gallery":
        setGalleryOpen(true);
        break;
      case "cookbook":
        setCookbookOpen(true);
        break;
      case "models":
        setModelsOpen(true);
        break;
      case "tasks":
        setTasksOpen(true);
        break;
      case "editor":
        setEditorOpen(true);
        break;
      case "group":
        setGroupOpen(true);
        break;
      case "admin":
        setAdminOpen(true);
        break;
      case "voice":
        setVoiceOpen(true);
        break;
      default:
        setPresetsOpen(true);
    }
  }, []);

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

  // odysseus _wasAutoCollapsed: remembers that the sidebar was collapsed *by*
  // the responsive auto-collapse (not the user), so it is only auto-restored
  // when the viewport grows back to desktop. A user toggle clears it.
  const wasAutoCollapsedRef = useRef(false);

  const toggleSidebar = useCallback(() => {
    // A deliberate toggle is always the user's intent — drop the auto-collapse
    // flag so a later desktop resize doesn't pop the drawer back open.
    wasAutoCollapsedRef.current = false;
    setSidebarCollapsed((prev) => {
      // The collapsed pref is desktop-only: on mobile the drawer is transient
      // overlay state and must not overwrite the user's desktop preference.
      if (!isMobile) writePref(PREF_KEYS.sidebarCollapsed, !prev);
      return !prev;
    });
  }, [isMobile]);

  // Responsive auto-collapse (odysseus sidebar-layout.js checkSidebarAutoCollapse
  // + the resize listener it cleans up). Crossing below MOBILE_BREAKPOINT
  // collapses the sidebar into the overlay drawer; growing back to desktop
  // restores it only if the auto-collapse is what hid it. The drawer also
  // starts closed every time we enter mobile so the chat is unobstructed.
  useEffect(() => {
    const onResize = () => {
      const mobile = window.innerWidth < MOBILE_BREAKPOINT;
      setIsMobile(mobile);
      setSidebarCollapsed((prev) => {
        if (mobile) {
          if (!prev) {
            wasAutoCollapsedRef.current = true;
            return true;
          }
          return prev;
        }
        if (prev && wasAutoCollapsedRef.current) {
          wasAutoCollapsedRef.current = false;
          return false;
        }
        return prev;
      });
    };
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // On mobile the drawer is "open" when not collapsed; selecting a thread or
  // starting a new chat should dismiss it so the chat is visible (odysseus
  // closes the sidebar on navigation on phones).
  const closeMobileDrawer = useCallback(() => {
    if (isMobile) setSidebarCollapsed(true);
  }, [isMobile]);

  // Keyboard shortcuts (odysseus keyboard-shortcuts.js): toggle sidebar, new
  // chat, focus composer, and open the tool surfaces. Only actions wired here
  // are bound; AltGr-safe + suppressed while typing (except focusInput).
  useKeyboardShortcuts({
    toggleSidebar,
    newSession: onNewChat,
    focusInput: () => {
      const ta = document.querySelector<HTMLTextAreaElement>(
        '.odysseus-root textarea[aria-label="Message input"]',
      );
      ta?.focus();
    },
    openSettings: () => setSettingsOpen(true),
    openCalendar: () => setCalendarOpen(true),
    openCompare: () => setCompareOpen(true),
    openCookbook: () => setCookbookOpen(true),
    openResearch: () => setResearchOpen(true),
    openGallery: () => setGalleryOpen(true),
    openMemory: () => setMemoryOpen(true),
    openNotes: () => setNotesOpen(true),
    openTasks: () => setTasksOpen(true),
    openModels: () => setModelsOpen(true),
    openTheme: () => setThemeMenuOpen(true),
  });

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
  // The full palette object is dozens of CSS vars derived via HSL color math;
  // recomputing it on every keystroke (input state lives in this component) is
  // wasteful, so memoize on the inputs that actually change the palette.
  const themeStyle = useMemo(
    () =>
      themeName === "custom"
        ? buildThemeVars(customColors)
        : customThemes[themeName]
          ? buildThemeVars(customThemes[themeName])
          : themeVars(themeName),
    [themeName, customColors, customThemes],
  );

  // Below MOBILE_BREAKPOINT the sidebar is an overlay drawer: it is open when
  // not collapsed (odysseus .sidebar:not(.hidden) on mobile). The root carries
  // .od-mobile (switches the sidebar/backdrop CSS into overlay mode) and
  // .od-sidebar-open (drives the slide-in + backdrop visibility).
  const drawerOpen = isMobile && !sidebarCollapsed;

  return (
    <WindowManagerProvider>
      <div
        className={`odysseus-root od-density-${density}${bgPattern !== "none" ? ` od-bg-${bgPattern}` : ""}${isMobile ? " od-mobile" : ""}${drawerOpen ? " od-sidebar-open" : ""}`}
        style={{ ...themeStyle, fontFamily: FONT_MAP[font] }}
        data-od-theme={themeName}
        data-testid="odysseus-shell"
      >
        {/** biome-ignore lint/security/noDangerouslySetInnerHtml: static, build-time CSS constant (no user input) */}
        <style dangerouslySetInnerHTML={{ __html: ODYSSEUS_CSS }} />
        <BgEffect pattern={bgPattern} />
        {/* odysseus sidebar-layout.js: the 48px icon rail and the wide labeled
          sidebar are mutually exclusive — the rail shows ONLY when the sidebar
          is collapsed on desktop (`sidebarHidden && !railHidden`). When the
          sidebar is expanded, all feature navigation lives inside it instead. */}
        {!isMobile && sidebarCollapsed ? (
          <IconRail
            onToggleSidebar={toggleSidebar}
            onNewChat={onNewChat}
            onOpenTheme={() => setThemeMenuOpen(true)}
            onOpenMemory={() => setMemoryOpen(true)}
            onOpenSkills={() => setSkillsOpen(true)}
            onOpenNotes={() => setNotesOpen(true)}
            onOpenSettings={() => setSettingsOpen(true)}
            onOpenCompare={() => setCompareOpen(true)}
            onOpenResearch={() => setResearchOpen(true)}
            onOpenDocs={() => setDocsOpen(true)}
            onOpenCalendar={() => setCalendarOpen(true)}
            onOpenEmail={() => setEmailOpen(true)}
            onOpenGallery={() => setGalleryOpen(true)}
            onOpenCookbook={() => setCookbookOpen(true)}
            onOpenModels={() => setModelsOpen(true)}
            onOpenTasks={() => setTasksOpen(true)}
            onOpenEditor={() => setEditorOpen(true)}
            onOpenGroup={() => setGroupOpen(true)}
            onOpenAdmin={() => setAdminOpen(true)}
            onOpenVoice={() => setVoiceOpen(true)}
            onOpenPresets={() => setPresetsOpen(true)}
          />
        ) : null}
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
        <DocumentLibraryView
          open={docsOpen}
          onClose={() => setDocsOpen(false)}
        />
        <CompareView open={compareOpen} onClose={() => setCompareOpen(false)} />
        <ResearchView
          open={researchOpen}
          onClose={() => setResearchOpen(false)}
        />
        <CalendarView
          open={calendarOpen}
          onClose={() => setCalendarOpen(false)}
        />
        <EmailView open={emailOpen} onClose={() => setEmailOpen(false)} />
        <GalleryView open={galleryOpen} onClose={() => setGalleryOpen(false)} />
        <CookbookView
          open={cookbookOpen}
          onClose={() => setCookbookOpen(false)}
        />
        <ModelsView open={modelsOpen} onClose={() => setModelsOpen(false)} />
        <TasksView open={tasksOpen} onClose={() => setTasksOpen(false)} />
        <GalleryEditorView
          open={editorOpen}
          onClose={() => setEditorOpen(false)}
        />
        <GroupChatView
          open={groupOpen}
          onClose={() => setGroupOpen(false)}
          initialTaskId={selectedId ?? undefined}
        />
        <AdminView open={adminOpen} onClose={() => setAdminOpen(false)} />
        <VoiceView open={voiceOpen} onClose={() => setVoiceOpen(false)} />
        <PresetsPanel
          open={presetsOpen}
          onClose={() => setPresetsOpen(false)}
        />
        <SettingsPanel
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
        />
        <SearchPalette
          open={searchOpen}
          onClose={() => setSearchOpen(false)}
          onSelect={setSelectedId}
        />
        {/* Mobile: a tap-to-close backdrop behind the overlay drawer (odysseus
          #sidebar-backdrop). Pure-CSS visibility is gated by .od-sidebar-open;
          we mount it only on mobile so desktop keeps a clean layout. */}
        {isMobile ? (
          <button
            type="button"
            className="od-sidebar-backdrop"
            aria-label="Close sidebar"
            tabIndex={drawerOpen ? 0 : -1}
            onClick={() => setSidebarCollapsed(true)}
          />
        ) : null}
        {/* Desktop renders the sidebar only when expanded (in-flow, resizable).
          Mobile keeps it mounted so the drawer can slide in/out via CSS
          transform; the .od-mobile class makes width/resize a no-op there. */}
        {isMobile || !sidebarCollapsed ? (
          <SessionSidebar
            threads={threads}
            selectedId={selectedId}
            onSelect={(id) => {
              setSelectedId(id);
              closeMobileDrawer();
            }}
            onNewChat={() => {
              onNewChat();
              closeMobileDrawer();
            }}
            onSearch={() => setSearchOpen(true)}
            onRename={onRenameThread}
            onDelete={onDeleteThread}
            width={sidebarWidth}
            onResizeStart={startResize}
            pinnedIds={pinnedIds}
            onTogglePin={onTogglePin}
            onToggleSidebar={toggleSidebar}
            onOpenTool={openTool}
          />
        ) : null}
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
          onOpenModels={() => setModelsOpen(true)}
          roomError={roomError}
          roomStale={roomStale}
          onRetryRoom={retryRoom}
        />
        {/* Bottom-left dock of minimized tool windows (odysseus
          #minimized-dock), above the composer. Renders nothing until a view
          minimizes itself; chip click restores, × closes. */}
        <MinimizedDock />
      </div>
    </WindowManagerProvider>
  );
}
