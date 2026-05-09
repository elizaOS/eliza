/**
 * Styled JSON editor component for editing character data.
 * Provides syntax highlighting, validation, and error display.
 *
 * @param props - JSON editor configuration
 * @param props.character - Character data to edit
 * @param props.onChange - Callback when character data changes
 * @param props.isValid - Whether current JSON is valid
 * @param props.error - Error message if JSON is invalid
 */

"use client";

import { useEffect, useState } from "react";
import type { ElizaCharacter } from "@/lib/types";

interface JsonEditorStyledProps {
  character: ElizaCharacter;
  onChange: (character: ElizaCharacter) => void;
  isValid: boolean;
  error: string | null;
}

export function JsonEditorStyled({ character, onChange, isValid, error }: JsonEditorStyledProps) {
  const [jsonText, setJsonText] = useState("");

  useEffect(() => {
    setJsonText(JSON.stringify(character, null, 2));
  }, [character]);

  const handleJsonChange = (value: string) => {
    setJsonText(value);

    try {
      const parsed = JSON.parse(value);
      onChange(parsed as ElizaCharacter);
    } catch (err) {
      // Invalid JSON - parent component handles validation
      // Only catch to prevent crash while user is typing
      if (err instanceof SyntaxError) {
        // Expected error during typing, parent handles validation
        return;
      }
      // Re-throw unexpected errors
      throw err;
    }
  };

  return (
    <div className="flex h-full flex-col">
      {error && (
        <div className="flex-shrink-0 border-b border-white/10 p-4">
          <div className="flex items-center gap-2">
            <p className="text-sm text-rose-400">
              <strong>Error:</strong> {error}
            </p>
          </div>
        </div>
      )}
      <div className="flex-1 overflow-auto">
        <style>{`
          .json-editor {
            font-family:
              "Monaco", "Menlo", "Ubuntu Mono", "Consolas", "source-code-pro",
              monospace;
            font-size: 13px;
            line-height: 1.6;
            padding: 16px;
            width: 100%;
            height: 100%;
            background: transparent;
            color: #d4d4d4;
            border: none;
            outline: none;
            resize: none;
            white-space: pre;
            overflow-wrap: normal;
            overflow-x: auto;
            tab-size: 2;
            -moz-tab-size: 2;
          }

          .json-editor::selection {
            background: rgba(255, 88, 0, 0.3);
          }
        `}</style>
        <textarea
          value={jsonText}
          onChange={(e) => handleJsonChange(e.target.value)}
          className="json-editor"
          spellCheck={false}
          placeholder="Character JSON will appear here..."
        />
      </div>
    </div>
  );
}
