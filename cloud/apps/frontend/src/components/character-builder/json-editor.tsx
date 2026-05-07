/**
 * JSON editor component for editing character data with Monaco editor.
 * Provides syntax highlighting, validation, save functionality, and download capability.
 *
 * @param props - JSON editor configuration
 * @param props.character - Character data to edit
 * @param props.onChange - Callback when character data changes
 * @param props.onSave - Callback when save button is clicked
 * @param props.hideActions - Whether to hide action buttons
 */

"use client";

import { BrandButton, MonacoEditorSkeleton } from "@elizaos/cloud-ui/primitives";
import dynamic from "@elizaos/cloud-ui/runtime/dynamic";
import { AlertCircle, CheckCircle, Save, Upload } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import type { ElizaCharacter } from "@/lib/types";

// Dynamic import Monaco editor to reduce initial bundle size (~500KB savings)
const MonacoJsonEditor = dynamic(
  () =>
    import("../chat/monaco-json-editor").then(
      (mod) => mod.MonacoJsonEditor,
    ),
  {
    ssr: false,
    loading: () => <MonacoEditorSkeleton />,
  },
);

interface JsonEditorProps {
  character: ElizaCharacter;
  onChange: (character: ElizaCharacter) => void;
  onSave: () => Promise<void>;
  hideActions?: boolean;
}

interface EditorState {
  jsonText: string;
  isValid: boolean;
  error: string | null;
  isSaving: boolean;
}

export function JsonEditor({ character, onChange, onSave, hideActions = false }: JsonEditorProps) {
  const [editorState, setEditorState] = useState<EditorState>({
    jsonText: "",
    isValid: true,
    error: null,
    isSaving: false,
  });

  const updateEditor = useCallback((updates: Partial<EditorState>) => {
    setEditorState((prev) => ({ ...prev, ...updates }));
  }, []);

  useEffect(() => {
    // Use queueMicrotask to defer execution and avoid synchronous setState
    queueMicrotask(() => {
      updateEditor({ jsonText: JSON.stringify(character, null, 2) });
    });
  }, [character, updateEditor]);

  const handleJsonChange = (value: string) => {
    try {
      const parsed = JSON.parse(value);
      updateEditor({ jsonText: value, isValid: true, error: null });
      onChange(parsed as ElizaCharacter);
    } catch (err) {
      updateEditor({
        jsonText: value,
        isValid: false,
        error: (err as Error).message,
      });
    }
  };

  const handleExport = () => {
    const blob = new Blob([editorState.jsonText], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${character.name || "character"}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast.success("Character exported successfully!");
  };

  const handleSave = async () => {
    if (!editorState.isValid) {
      toast.error("Cannot save invalid JSON");
      return;
    }

    updateEditor({ isSaving: true });
    await onSave();
    toast.success("Character saved successfully!");
    updateEditor({ isSaving: false });
  };

  return (
    <div className="flex h-full flex-col rounded-2xl overflow-hidden bg-black/90">
      {!hideActions && (
        <div className="flex-shrink-0 border-b border-white/10 p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <h3 className="text-lg font-bold text-white">Character JSON</h3>
              {editorState.isValid ? (
                <CheckCircle className="h-5 w-5 text-green-400" />
              ) : (
                <AlertCircle className="h-5 w-5 text-rose-400" />
              )}
            </div>
            <div className="flex gap-2">
              <BrandButton
                variant="outline"
                size="sm"
                onClick={handleExport}
                disabled={!editorState.isValid}
              >
                <Upload className="mr-2 h-4 w-4" />
                Export
              </BrandButton>
              <BrandButton
                variant="primary"
                size="sm"
                onClick={handleSave}
                disabled={!editorState.isValid || editorState.isSaving}
              >
                <Save className="mr-2 h-4 w-4" />
                {editorState.isSaving ? "Saving..." : "Save"}
              </BrandButton>
            </div>
          </div>
          {editorState.error && (
            <p className="mt-2 text-sm text-rose-400">
              <strong>Error:</strong> {editorState.error}
            </p>
          )}
        </div>
      )}
      {hideActions && editorState.error && (
        <div className="flex-shrink-0 border-b border-white/10 p-4">
          <div className="flex items-center gap-2">
            <AlertCircle className="h-5 w-5 text-rose-400" />
            <p className="text-sm text-rose-400">
              <strong>Error:</strong> {editorState.error}
            </p>
          </div>
        </div>
      )}
      <div className="flex-1 overflow-hidden">
        <MonacoJsonEditor
          value={editorState.jsonText}
          onChange={handleJsonChange}
          isValid={editorState.isValid}
        />
      </div>
    </div>
  );
}
