/**
 * The Personality section of the Character family (#13591): the identity, style,
 * and message-example editor for the active agent. Renders a headerless body —
 * the shared `CharacterSectionNav` supplies the "Character" header + section
 * strip in the shell nav slot; the other three family sections (Relationships,
 * Skills, Experience) are their own promoted top-level views.
 *
 * Edits autosave: field/style/example changes debounce a `PATCH` through the
 * client (700 ms), and a pending patch is flushed on unmount so a fast
 * section-switch never drops the last edit. There is no manual Save button — the
 * ViewHeader right slot shows a subtle saved/error status instead (step 7). This
 * view once rendered all six hub sections internally (overview + the four now-
 * promoted views); that dual render path is gone, so the hub owns Personality
 * only.
 */
import type { MessageExampleGroup } from "@elizaos/core";
import { useCallback, useEffect, useRef } from "react";
import { client } from "../../api/client";
import type { CharacterData } from "../../api/client-types";
import { useRenderGuard } from "../../hooks/useRenderGuard";
import { WorkspaceLayout } from "../../layouts/workspace-layout/workspace-layout";
import { useAppSelectorShallow } from "../../state";
// Direct sub-path import to avoid the widgets/index.ts ↔ WidgetHost.tsx
// chunk-level circular dependency.
import { WidgetHost } from "../../widgets/WidgetHost";
import {
  CharacterExamplesPanel,
  CharacterIdentityPanel,
  CharacterStylePanel,
} from "./CharacterEditorPanels";

type CharacterStyleSection = "all" | "chat" | "post";

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

export function CharacterHubView({
  d,
  bioText,
  normalizedMessageExamples,
  pendingStyleEntries,
  styleEntryDrafts,
  applyFieldEdit,
  handlePendingStyleEntryChange,
  applyStyleEdit,
  handleStyleEntryDraftChange,
  characterSaveError,
}: {
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
  characterSaveError: string | null;
}) {
  useRenderGuard("CharacterHubView");
  const { setActionNotice, t } = useAppSelectorShallow((s) => ({
    setActionNotice: s.setActionNotice,
    t: s.t,
  }));
  const autoSaveTimerRef = useRef<number | null>(null);
  const pendingAutoSavePatchRef = useRef<CharacterData>({});

  const flushPendingAutoSave = useCallback(async () => {
    if (autoSaveTimerRef.current !== null) {
      window.clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = null;
    }
    const patch = pendingAutoSavePatchRef.current;
    if (Object.keys(patch).length === 0) return;
    pendingAutoSavePatchRef.current = {};
    // error-policy:J4 autosave failure degrades to a visible action notice; the
    // edit stays in the form so the next debounce retries it.
    try {
      await client.updateCharacter(patch);
    } catch (error) {
      setActionNotice(
        error instanceof Error
          ? error.message
          : "Failed to autosave personality updates.",
        "error",
        5000,
      );
    }
  }, [setActionNotice]);

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

  // Flush a pending edit on unmount (fast section-switch) so the last change is
  // never dropped.
  useEffect(() => {
    return () => {
      void flushPendingAutoSave();
    };
  }, [flushPendingAutoSave]);

  const handleAutoSavedExamplesEdit = useCallback(
    (field: string, value: unknown) => {
      applyFieldEdit(field, value);
      if (field === "messageExamples" || field === "postExamples") {
        scheduleAutoSave({ [field]: value } as CharacterData);
      }
    },
    [applyFieldEdit, scheduleAutoSave],
  );

  // Identity fields (bio) autosave on the same debounce as style/examples. This
  // view has no manual Save button, so an identity edit that only updated the
  // draft would be lost on section-switch; scheduling the patch here is the only
  // persistence path for the field.
  const handleAutoSavedFieldEdit = useCallback(
    (field: string, value: unknown) => {
      applyFieldEdit(field, value);
      scheduleAutoSave({ [field]: value } as CharacterData);
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

  return (
    <WorkspaceLayout
      className="h-full"
      contentPadding={false}
      contentInnerClassName="flex w-full min-h-0 flex-1 flex-col"
      data-testid="character-editor-view"
    >
      <div className="custom-scrollbar mx-auto flex min-h-0 w-full min-w-0 max-w-6xl flex-1 flex-col overflow-y-auto overflow-x-hidden px-4 pb-32 pt-1 sm:px-5 lg:px-6">
        <WidgetHost slot="character" className="mb-4" />
        <div className="flex min-w-0 flex-col gap-6">
          {characterSaveError ? (
            <span className="rounded-sm border border-status-danger/20 bg-status-danger-bg px-2 py-1 text-2xs font-medium text-status-danger">
              {characterSaveError}
            </span>
          ) : null}
          <section>
            <CharacterIdentityPanel
              nameText={typeof d.name === "string" ? d.name : ""}
              systemText={typeof d.system === "string" ? d.system : ""}
              bioText={bioText}
              handleFieldEdit={handleAutoSavedFieldEdit}
              t={t}
            />
          </section>

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

          <section>
            <CharacterExamplesPanel
              d={d}
              normalizedMessageExamples={normalizedMessageExamples}
              handleFieldEdit={handleAutoSavedExamplesEdit}
              t={t}
            />
          </section>
        </div>
      </div>
    </WorkspaceLayout>
  );
}
