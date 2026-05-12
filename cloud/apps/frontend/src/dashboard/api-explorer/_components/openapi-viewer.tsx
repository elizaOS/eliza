/**
 * OpenAPI viewer component displaying OpenAPI specification in Monaco editor.
 * Provides syntax highlighting with custom theme matching application design.
 *
 * @param props - OpenAPI viewer configuration
 * @param props.value - OpenAPI specification JSON string
 */

"use client";

import Editor, { Monaco } from "@monaco-editor/react";
import type * as monacoEditor from "monaco-editor";
import { useRef } from "react";
import { cn } from "@/lib/utils";

interface OpenApiViewerProps {
  value: string;
  className?: string;
}

export function OpenApiViewer({ value, className }: OpenApiViewerProps) {
  const editorRef = useRef<monacoEditor.editor.IStandaloneCodeEditor | null>(null);

  const handleEditorDidMount = (
    editor: monacoEditor.editor.IStandaloneCodeEditor,
    monaco: Monaco,
  ) => {
    editorRef.current = editor;

    // Define custom dark theme matching your color scheme
    monaco.editor.defineTheme("elizaTheme", {
      base: "vs-dark",
      inherit: true,
      rules: [
        { token: "string.key.json", foreground: "FE9F6D" }, // Keys - orange
        { token: "string.value.json", foreground: "D4D4D4" }, // String values - gray
        { token: "number", foreground: "D4D4D4" }, // Numbers - gray
        { token: "keyword.json", foreground: "D4D4D4" }, // true/false/null - gray
        { token: "delimiter.bracket.json", foreground: "E434BB" }, // Brackets - pink
        { token: "delimiter.array.json", foreground: "E434BB" }, // Arrays - pink
        { token: "delimiter.colon.json", foreground: "E434BB" }, // Colons - pink
        { token: "delimiter.comma.json", foreground: "E434BB" }, // Commas - pink
      ],
      colors: {
        "editor.background": "#00000000", // Transparent background
        "editor.foreground": "#D4D4D4",
        "editorLineNumber.foreground": "#858585",
        "editorLineNumber.activeForeground": "#C6C6C6",
        "editorGutter.background": "#0a0a0a",
        "editorCursor.foreground": "#FFFFFF",
        "editor.selectionBackground": "#264F78",
        "editor.inactiveSelectionBackground": "#3A3D41",
        "editorIndentGuide.background": "#404040",
        "editorIndentGuide.activeBackground": "#707070",
        "editor.lineHighlightBackground": "#FFFFFF0A",
        "editorBracketMatch.background": "#0064001A",
        "editorBracketMatch.border": "#888888",
        "editorStickyScroll.background": "#0a0a0a",
        "editorStickyScrollHover.background": "#171717",
      },
    });

    // Apply the theme
    monaco.editor.setTheme("elizaTheme");

    // Configure JSON language features
    monaco.languages.json.jsonDefaults.setDiagnosticsOptions({
      validate: true,
      allowComments: false,
      schemas: [],
      enableSchemaRequest: false,
    });
  };

  return (
    <div
      className={cn(
        "w-full min-w-0 max-w-full rounded-lg border border-white/10 bg-black/40 overflow-hidden",
        className,
      )}
    >
      <div className="w-0 min-w-full h-full overflow-hidden">
        <Editor
          height="100%"
          defaultLanguage="json"
          value={value}
          onMount={handleEditorDidMount}
          options={{
            readOnly: true,
            fontSize: 13,
            fontFamily: '"Monaco", "Menlo", "Ubuntu Mono", "Consolas", monospace',
            lineHeight: 21,
            tabSize: 2,
            insertSpaces: true,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            wordWrap: "off",
            wrappingStrategy: "advanced",
            automaticLayout: true,
            smoothScrolling: true,
            cursorBlinking: "solid",
            renderLineHighlight: "none",
            bracketPairColorization: {
              enabled: true,
            },
            guides: {
              bracketPairs: true,
              indentation: true,
            },
            folding: true,
            foldingStrategy: "indentation",
            showFoldingControls: "mouseover",
            padding: {
              top: 16,
              bottom: 16,
            },
            // Read-only specific options
            domReadOnly: true,
            readOnlyMessage: {
              value:
                "This OpenAPI specification is read-only. Use the Copy buttons above to export.",
            },
            contextmenu: true,
            selectOnLineNumbers: true,
            lineNumbers: "on",
            glyphMargin: false,
            scrollbar: {
              vertical: "visible",
              horizontal: "visible",
              verticalScrollbarSize: 10,
              horizontalScrollbarSize: 10,
            },
          }}
        />
      </div>
    </div>
  );
}
