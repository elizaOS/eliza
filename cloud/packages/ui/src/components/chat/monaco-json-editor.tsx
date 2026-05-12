/**
 * Monaco JSON editor component with custom theme and syntax highlighting.
 * Provides JSON editing with validation feedback and custom color scheme.
 *
 * @param props - Monaco JSON editor configuration
 * @param props.value - JSON string value
 * @param props.onChange - Callback when editor content changes
 * @param props.isValid - Whether current JSON is valid
 */

"use client";

import Editor, { Monaco } from "@monaco-editor/react";
import type * as monacoEditor from "monaco-editor";
import { useEffect, useRef } from "react";

interface MonacoJsonEditorProps {
  value: string;
  onChange: (value: string) => void;
  isValid: boolean;
}

export function MonacoJsonEditor({ value, onChange, isValid }: MonacoJsonEditorProps) {
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
        "editorCursor.foreground": "#FFFFFF",
        "editor.selectionBackground": "#264F78",
        "editor.inactiveSelectionBackground": "#3A3D41",
        "editorIndentGuide.background": "#404040",
        "editorIndentGuide.activeBackground": "#707070",
        "editor.lineHighlightBackground": "#FFFFFF0A",
        "editorBracketMatch.background": "#0064001A",
        "editorBracketMatch.border": "#888888",
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

    // Focus editor on mount
    editor.focus();
  };

  const handleEditorChange = (value: string | undefined) => {
    if (value !== undefined) {
      onChange(value);
    }
  };

  // Update border color based on validation
  useEffect(() => {
    const editorElement = editorRef.current?.getDomNode();
    if (editorElement) {
      if (!isValid) {
        editorElement.style.border = "1px solid #F43F5E";
      } else {
        editorElement.style.border = "none";
      }
    }
  }, [isValid]);

  return (
    <div className="h-full w-full">
      <Editor
        height="100%"
        defaultLanguage="json"
        value={value}
        onChange={handleEditorChange}
        onMount={handleEditorDidMount}
        options={{
          fontSize: 14,
          fontFamily:
            '"SF Mono", "Monaco", "Menlo", "Ubuntu Mono", "Consolas", "Courier New", monospace',
          lineHeight: 20,
          tabSize: 2,
          insertSpaces: true,
          autoIndent: "full",
          formatOnPaste: true,
          formatOnType: true,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          wordWrap: "off",
          wrappingStrategy: "advanced",
          automaticLayout: true,
          smoothScrolling: true,
          cursorBlinking: "smooth",
          cursorSmoothCaretAnimation: "on",
          renderLineHighlight: "all",
          renderWhitespace: "selection",
          bracketPairColorization: {
            enabled: true,
          },
          guides: {
            bracketPairs: true,
            indentation: true,
          },
          suggest: {
            showKeywords: true,
            showSnippets: true,
          },
          quickSuggestions: {
            strings: true,
          },
          folding: true,
          foldingStrategy: "indentation",
          showFoldingControls: "mouseover",
          padding: {
            top: 16,
            bottom: 16,
          },
          glyphMargin: false,
          lineNumbers: "on",
          lineNumbersMinChars: 3,
          lineDecorationsWidth: 0,
          scrollbar: {
            useShadows: false,
            verticalScrollbarSize: 10,
            horizontalScrollbarSize: 10,
          },
        }}
      />
    </div>
  );
}
