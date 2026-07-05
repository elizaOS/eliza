/**
 * The top-level "Character" view: the personality editor (About, Style Rules,
 * Chat Examples, Post Examples) folded into a single top-bar section nav
 * (#13591). The former endless single-page form and the overview CTA grid are
 * gone; Knowledge, Relationships, Skills, and Experience are separate top-level
 * views (their `/character/*` deep-links resolve to those promoted tabs, never
 * here). This view owns only Personality: one `CharacterSectionNav` (a shared
 * `ViewHeader` + section strip) over the active section's panel.
 *
 * Edits autosave — there is no Save button. Every field/style/example change is
 * debounced into a single `client.updateCharacter` patch; the header's trailing
 * slot shows the saving/saved/error status so the write stays observable.
 */
import type { MessageExampleGroup } from "@elizaos/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { client } from "../../api/client";
import type { CharacterData } from "../../api/client-types";
import { useRenderGuard } from "../../hooks/useRenderGuard";
import { WorkspaceLayout } from "../../layouts/workspace-layout/workspace-layout";
import {
  getWindowNavigationPath,
  shouldUseHashNavigation,
} from "../../navigation";
import { useAppSelectorShallow } from "../../state";
// Direct sub-path import to avoid the widgets/index.ts ↔ WidgetHost.tsx
// chunk-level circular dependency.
import { WidgetHost } from "../../widgets/WidgetHost";
import {
  CharacterChatExamplesPanel,
  CharacterIdentityPanel,
  CharacterPostExamplesPanel,
  CharacterStylePanel,
} from "./CharacterEditorPanels";
import {
  CHARACTER_SECTION_PATHS,
  type CharacterPersonalitySection,
  CharacterSectionNav,
  characterSectionFromPath,
} from "./CharacterSectionNav";

type CharacterStyleSection = "all" | "chat" | "post";
type AutoSaveStatus = "idle" | "saving" | "saved" | "error";

function mergeCharacterPatch(
  base: CharacterData,
  patch: CharacterData,
): CharacterData {
  return {
    ...base,
    ...patch,
    style: patch.style ? { ...(base.style ?? {}), ...patch.style } : base.style,
  };
}

function updateCharacterSectionPath(
  section: CharacterPersonalitySection,
): void {
  if (typeof window === "undefined") return;
  const path = CHARACTER_SECTION_PATHS[section];
  if (!path || getWindowNavigationPath() === path) return;
  if (shouldUseHashNavigation()) {
    window.location.hash = path;
    return;
  }
  window.history.pushState(null, "", path);
}

export function CharacterHubView({
  initialSection,
  d,
  bioText,
  normalizedMessageExamples,
  pendingStyleEntries,
  styleEntryDrafts,
  applyFieldEdit,
  handlePendingStyleEntryChange,
  applyStyleEdit,
  handleStyleEntryDraftChange,
}: {
  initialSection?: CharacterPersonalitySection;
  d: CharacterData;
  bioText: string;
  normalizedMessageExamples: MessageExampleGroup[];
  pendingStyleEntries: Record<string, string>;
  styleEntryDrafts: Record<string, string[]>;
  applyFieldEdit: (field: string, value: unknown) => void;
  handlePendingStyleEntryChange: (key: string, value: string) => void;
  applyStyleEdit: (key: CharacterStyleSection, value: string) => void;
  handleStyleEntryDraftChange: (
    key: string,
    index: number,
    value: string,
  ) => void;
}) {
  useRenderGuard("CharacterHubView");
  const { t } = useAppSelectorShallow((s) => ({ t: s.t }));
  const [activeSection, setActiveSection] =
    useState<CharacterPersonalitySection>(
      () =>
        initialSection ?? characterSectionFromPath(getWindowNavigationPath()),
    );
  const [saveStatus, setSaveStatus] = useState<AutoSaveStatus>("idle");

  const autoSaveTimerRef = useRef<number | null>(null);
  const savedClearTimerRef = useRef<number | null>(null);
  const pendingAutoSavePatchRef = useRef<CharacterData>({});

  const flushPendingAutoSave = useCallback(async () => {
    if (autoSaveTimerRef.current !== null) {
      window.clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = null;
    }
    const patch = pendingAutoSavePatchRef.current;
    if (Object.keys(patch).length === 0) return;
    pendingAutoSavePatchRef.current = {};
    setSaveStatus("saving");
    try {
      await client.updateCharacter(patch);
      setSaveStatus("saved");
      if (savedClearTimerRef.current !== null) {
        window.clearTimeout(savedClearTimerRef.current);
      }
      savedClearTimerRef.current = window.setTimeout(() => {
        setSaveStatus("idle");
      }, 2500);
    } catch {
      // error-policy:J4 the write failure degrades to a visible "error" status
      // in the header (not a fabricated "saved"); the edit stays in the draft so
      // the next keystroke retries the patch.
      setSaveStatus("error");
    }
  }, []);

  const scheduleAutoSave = useCallback(
    (patch: CharacterData) => {
      pendingAutoSavePatchRef.current = mergeCharacterPatch(
        pendingAutoSavePatchRef.current,
        patch,
      );
      if (autoSaveTimerRef.current !== null) {
        window.clearTimeout(autoSaveTimerRef.current);
      }
      autoSaveTimerRef.current = window.setTimeout(() => {
        autoSaveTimerRef.current = null;
        void flushPendingAutoSave();
      }, 700);
    },
    [flushPendingAutoSave],
  );

  useEffect(() => {
    return () => {
      void flushPendingAutoSave();
      if (savedClearTimerRef.current !== null) {
        window.clearTimeout(savedClearTimerRef.current);
      }
    };
  }, [flushPendingAutoSave]);

  useEffect(() => {
    if (initialSection) {
      setActiveSection(initialSection);
      return;
    }
    const sync = () => {
      setActiveSection(characterSectionFromPath(getWindowNavigationPath()));
    };
    sync();
    window.addEventListener("popstate", sync);
    window.addEventListener("hashchange", sync);
    return () => {
      window.removeEventListener("popstate", sync);
      window.removeEventListener("hashchange", sync);
    };
  }, [initialSection]);

  const navigateToSection = useCallback(
    (section: CharacterPersonalitySection) => {
      setActiveSection(section);
      if (initialSection) return;
      updateCharacterSectionPath(section);
    },
    [initialSection],
  );

  const handleAutoSavedIdentityEdit = useCallback(
    (field: string, value: unknown) => {
      applyFieldEdit(field, value);
      scheduleAutoSave({ [field]: value } as CharacterData);
    },
    [applyFieldEdit, scheduleAutoSave],
  );

  const handleAutoSavedExamplesEdit = useCallback(
    (field: string, value: unknown) => {
      applyFieldEdit(field, value);
      if (field === "messageExamples" || field === "postExamples") {
        scheduleAutoSave({ [field]: value } as CharacterData);
      }
    },
    [applyFieldEdit, scheduleAutoSave],
  );

  const buildStylePatch = useCallback(
    (key: CharacterStyleSection, items: string[]): CharacterData => ({
      style: {
        ...(d.style ?? {}),
        [key]: items,
      },
    }),
    [d.style],
  );

  const handleAutoAddStyleEntry = useCallback(
    (key: string) => {
      const styleKey = key as CharacterStyleSection;
      const value = pendingStyleEntries[key]?.trim();
      if (!value) return;
      const currentItems = [...(d.style?.[styleKey] ?? [])];
      const nextItems = currentItems.includes(value)
        ? currentItems
        : [...currentItems, value];
      applyStyleEdit(styleKey, nextItems.join("\n"));
      handlePendingStyleEntryChange(key, "");
      scheduleAutoSave(buildStylePatch(styleKey, nextItems));
    },
    [
      applyStyleEdit,
      buildStylePatch,
      d.style,
      handlePendingStyleEntryChange,
      pendingStyleEntries,
      scheduleAutoSave,
    ],
  );

  const handleAutoRemoveStyleEntry = useCallback(
    (key: string, index: number) => {
      const styleKey = key as CharacterStyleSection;
      const nextItems = [...(d.style?.[styleKey] ?? [])];
      nextItems.splice(index, 1);
      applyStyleEdit(styleKey, nextItems.join("\n"));
      scheduleAutoSave(buildStylePatch(styleKey, nextItems));
    },
    [applyStyleEdit, buildStylePatch, d.style, scheduleAutoSave],
  );

  const handleAutoCommitStyleEntry = useCallback(
    (key: string, index: number) => {
      const styleKey = key as CharacterStyleSection;
      const nextValue = styleEntryDrafts[key]?.[index]?.trim() ?? "";
      const nextItems = [...(d.style?.[styleKey] ?? [])];
      if (!nextValue) {
        nextItems.splice(index, 1);
      } else {
        nextItems[index] = nextValue;
      }
      applyStyleEdit(styleKey, nextItems.join("\n"));
      scheduleAutoSave(buildStylePatch(styleKey, nextItems));
    },
    [
      applyStyleEdit,
      buildStylePatch,
      d.style,
      scheduleAutoSave,
      styleEntryDrafts,
    ],
  );

  const handleAutoReorderStyleEntries = useCallback(
    (key: string, items: string[]) => {
      const styleKey = key as CharacterStyleSection;
      applyStyleEdit(styleKey, items.join("\n"));
      scheduleAutoSave(buildStylePatch(styleKey, items));
    },
    [applyStyleEdit, buildStylePatch, scheduleAutoSave],
  );

  const saveStatusIndicator =
    saveStatus === "idle" ? null : (
      <span
        data-testid="character-save-status"
        className={
          saveStatus === "error"
            ? "text-2xs font-medium text-status-danger"
            : "text-2xs font-medium text-muted"
        }
      >
        {saveStatus === "saving"
          ? t("charactereditor.Saving", { defaultValue: "Saving…" })
          : saveStatus === "saved"
            ? t("charactereditor.Saved", { defaultValue: "Saved" })
            : t("charactereditor.SaveFailed", {
                defaultValue: "Save failed",
              })}
      </span>
    );

  const renderSection = () => {
    switch (activeSection) {
      case "style":
        return (
          <CharacterStylePanel
            d={d}
            pendingStyleEntries={pendingStyleEntries}
            styleEntryDrafts={styleEntryDrafts}
            handlePendingStyleEntryChange={handlePendingStyleEntryChange}
            handleAddStyleEntry={handleAutoAddStyleEntry}
            handleRemoveStyleEntry={handleAutoRemoveStyleEntry}
            handleStyleEntryDraftChange={handleStyleEntryDraftChange}
            handleCommitStyleEntry={handleAutoCommitStyleEntry}
            handleReorderStyleEntries={handleAutoReorderStyleEntries}
            t={t}
          />
        );
      case "chat-examples":
        return (
          <CharacterChatExamplesPanel
            d={d}
            normalizedMessageExamples={normalizedMessageExamples}
            handleFieldEdit={handleAutoSavedExamplesEdit}
            t={t}
          />
        );
      case "post-examples":
        return (
          <CharacterPostExamplesPanel
            d={d}
            normalizedMessageExamples={normalizedMessageExamples}
            handleFieldEdit={handleAutoSavedExamplesEdit}
            t={t}
          />
        );
      default:
        return (
          <CharacterIdentityPanel
            bioText={bioText}
            handleFieldEdit={handleAutoSavedIdentityEdit}
            t={t}
          />
        );
    }
  };

  return (
    <WorkspaceLayout
      className="h-full"
      contentPadding={false}
      contentInnerClassName="flex w-full min-h-0 flex-1 flex-col"
      data-testid="character-editor-view"
    >
      <CharacterSectionNav
        activeSection={activeSection}
        onSelect={navigateToSection}
        t={t}
        right={saveStatusIndicator}
      />
      <div className="custom-scrollbar mx-auto flex min-h-0 w-full min-w-0 max-w-6xl flex-1 flex-col overflow-y-auto overflow-x-hidden px-4 pb-32 pt-4 sm:px-5 lg:px-6">
        <WidgetHost slot="character" className="mb-4" />
        {renderSection()}
      </div>
    </WorkspaceLayout>
  );
}
