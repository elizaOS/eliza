/**
 * Character editor component with tabbed interface for editing character properties.
 * Supports form-based editing, JSON editing, plugins management, and knowledge uploads.
 *
 * @param props - Character editor configuration
 * @param props.character - Character data to edit
 * @param props.onChange - Callback when character data changes
 * @param props.onSave - Callback when save button is clicked
 */

"use client";

import { AnimatedTabs, Button, ScrollArea } from "@elizaos/cloud-ui";
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { ElizaCharacter } from "@/lib/types";
import type { PreUploadedFile } from "@/lib/types/knowledge";
import { CharacterForm, type FormTab } from "../agent-editor/character-form";
import { JsonEditor } from "../agent-editor/json-editor";
import { PluginsTab } from "./plugins-tab";
import { UploadsTab } from "./uploads-tab";

interface CharacterEditorProps {
  character: ElizaCharacter;
  onChange: (character: ElizaCharacter) => void;
  onSave: () => Promise<void>;
  onExit?: () => void;
  hasUnsavedChanges?: boolean;
  preUploadedFiles?: PreUploadedFile[];
  onPreUploadedFilesAdd?: (files: PreUploadedFile[]) => void;
  onPreUploadedFileRemove?: (fileId: string) => void;
}

type MainTab = "character" | "plugins" | "files";
const VALID_TABS: MainTab[] = ["character", "plugins", "files"];

export function CharacterEditor({
  character,
  onChange,
  onSave,
  onExit,
  hasUnsavedChanges = true,
  preUploadedFiles,
  onPreUploadedFilesAdd,
  onPreUploadedFileRemove,
}: CharacterEditorProps) {
  const [searchParams] = useSearchParams();
  const initialTab = searchParams.get("tab") as MainTab | null;
  const [activeTab, setActiveTab] = useState<MainTab>(
    initialTab && VALID_TABS.includes(initialTab) ? initialTab : "character",
  );
  const [activeFormTab, setActiveFormTab] = useState<FormTab>("basics");
  const [showJson, setShowJson] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  // Update tab when URL changes
  useEffect(() => {
    const tab = searchParams.get("tab") as MainTab | null;
    if (tab && VALID_TABS.includes(tab)) {
      // Schedule state update to avoid synchronous setState in effect
      const rafId = requestAnimationFrame(() => setActiveTab(tab));
      return () => cancelAnimationFrame(rafId);
    }
  }, [searchParams]);

  const formTabs = [
    { value: "basics", label: "Basics" },
    { value: "personality", label: "Personality" },
    { value: "style", label: "Style" },
    { value: "avatar", label: "Avatar" },
  ];

  const otherTabs = [
    { value: "plugins", label: "Plugins" },
    { value: "files", label: "Files" },
  ];

  // Handle form tab click - switches to character view with selected sub-tab
  const handleFormTabClick = (value: string) => {
    setActiveFormTab(value as FormTab);
    setActiveTab("character");
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      await onSave();
    } finally {
      setIsSaving(false);
    }
  };

  const handleExport = () => {
    const jsonText = JSON.stringify(character, null, 2);
    const blob = new Blob([jsonText], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${character.name || "character"}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex h-full flex-col rounded-2xl bg-[#0A0A0A]">
      {/* Header */}
      <div className="flex-shrink-0 px-3 sm:px-6 pt-3 md:pt-6">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 mb-2">
          <div className="hidden sm:flex items-center gap-2">
            {showJson ? (
              <h2 className="text-xl font-bold text-white">JSON Editor</h2>
            ) : (
              <h2 className="text-xl font-bold text-white">Agent Editor</h2>
            )}
          </div>
          <div className="flex items-center justify-between w-full sm:w-auto">
            <div className="flex gap-2 items-center justify-between">
              <div className="md:pl-2">JSON:</div>
              <div className="flex items-center -space-x-1.5 rounded-2xl border bg-white/10 border-white/20 p-0.5 mr-3">
                <Button
                  size={"sm"}
                  onClick={() => setShowJson(!showJson)}
                  className={`flex pl-3.5 pr-3 items-center rounded-xl text-white transition-colors z-10 border ${
                    showJson
                      ? "bg-red-900/60 border-red-500/50 hover:bg-red-800/80 hover:border-red-400/70"
                      : "bg-transparent border-transparent hover:bg-white/15"
                  }`}
                >
                  {showJson ? "Exit" : "Edit"}
                </Button>
                <Button
                  size={"sm"}
                  onClick={handleExport}
                  className="flex pl-3 pr-3.5 items-center rounded-xl text-white bg-transparent hover:bg-white/15 transition-colors"
                >
                  Export
                </Button>
              </div>
            </div>
            <Button
              onClick={hasUnsavedChanges ? handleSave : onExit}
              disabled={isSaving}
              className={`flex items-center w-20 rounded-2xl transition-colors border ${
                hasUnsavedChanges
                  ? "bg-[#FF5800]/40 text-white hover:bg-[#FF5800]/55 border-[#FF5800]/50 hover:border-[#FF5800]/90"
                  : "bg-red-900/60 text-white hover:bg-red-800/80 border-red-500/50 hover:border-red-400/70"
              }`}
            >
              {isSaving
                ? "Saving"
                : hasUnsavedChanges
                  ? character.id
                    ? "Save"
                    : "Deploy"
                  : "Exit"}
            </Button>
          </div>
        </div>
      </div>

      {/* Animated Tabs - Hidden in JSON mode */}
      {!showJson && (
        <div className="shrink-0 px-3 sm:px-6 pt-0 pb-6 flex flex-wrap items-center gap-y-2 gap-x-3">
          {/* Agent form tabs - always visible */}
          <AnimatedTabs
            tabs={formTabs}
            value={activeTab === "character" ? activeFormTab : ""}
            onValueChange={handleFormTabClick}
          />
          {/* Plugins/Files tabs */}
          <AnimatedTabs
            tabs={otherTabs}
            value={activeTab !== "character" ? activeTab : ""}
            onValueChange={(value) => setActiveTab(value as MainTab)}
          />
        </div>
      )}
      {/* Content Area - Full Height */}
      <div className="flex-1 overflow-hidden relative">
        {showJson ? (
          <div className="h-full px-3 sm:px-6 pb-3 sm:pb-6">
            <JsonEditor
              character={character}
              onChange={onChange}
              onSave={onSave}
              hideActions={true}
            />
          </div>
        ) : (
          <>
            {activeTab === "character" && activeFormTab === "avatar" ? (
              <div className="h-full px-3 sm:px-6 pt-1.5 pb-3 sm:pb-6">
                <CharacterForm
                  character={character}
                  onChange={onChange}
                  activeTab={activeFormTab}
                />
              </div>
            ) : activeTab === "character" ? (
              <ScrollArea className="h-full">
                <div className="px-3 sm:px-6 pb-3 sm:pb-6">
                  <CharacterForm
                    character={character}
                    onChange={onChange}
                    activeTab={activeFormTab}
                  />
                </div>
              </ScrollArea>
            ) : null}
            {activeTab === "plugins" && (
              <div className="h-full px-3 sm:px-6 pb-3 sm:pb-6">
                <PluginsTab
                  character={character}
                  onChange={(updates) => onChange({ ...character, ...updates })}
                  onSave={onSave}
                />
              </div>
            )}
            {activeTab === "files" && (
              <ScrollArea className="h-full">
                <div className="px-3 sm:px-6 pb-3 sm:pb-6">
                  <UploadsTab
                    characterId={character.id || null}
                    preUploadedFiles={preUploadedFiles}
                    onPreUploadedFilesAdd={onPreUploadedFilesAdd}
                    onPreUploadedFileRemove={onPreUploadedFileRemove}
                  />
                </div>
              </ScrollArea>
            )}
          </>
        )}
      </div>
    </div>
  );
}
