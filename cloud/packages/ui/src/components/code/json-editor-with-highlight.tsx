"use client";

import { useState } from "react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";

interface JsonEditorWithHighlightProps {
  value: string;
  onChange: (value: string) => void;
  isValid: boolean;
}

export function JsonEditorWithHighlight({
  value,
  onChange,
  isValid,
}: JsonEditorWithHighlightProps) {
  const [isEditing, setIsEditing] = useState(false);

  // Custom theme with your specified colors
  const customStyle = {
    'code[class*="language-"]': {
      color: "#D4D4D4",
      background: "transparent",
      fontFamily: '"Monaco", "Menlo", "Ubuntu Mono", "Consolas", monospace',
      fontSize: "13px",
      lineHeight: "1.6",
      textAlign: "left" as const,
      whiteSpace: "pre" as const,
      wordSpacing: "normal",
      wordBreak: "normal" as const,
      wordWrap: "normal" as const,
      tabSize: 2,
      hyphens: "none" as const,
    },
    'pre[class*="language-"]': {
      color: "#D4D4D4",
      background: "transparent",
      fontFamily: '"Monaco", "Menlo", "Ubuntu Mono", "Consolas", monospace',
      fontSize: "13px",
      lineHeight: "1.6",
      textAlign: "left" as const,
      whiteSpace: "pre" as const,
      wordSpacing: "normal",
      wordBreak: "normal" as const,
      wordWrap: "normal" as const,
      tabSize: 2,
      hyphens: "none" as const,
      padding: "16px",
      margin: "0",
      overflow: "auto",
      height: "100%",
    },
    property: {
      color: "#FE9F6D", // Keys
    },
    string: {
      color: "#D4D4D4", // String values
    },
    number: {
      color: "#D4D4D4", // Numbers
    },
    boolean: {
      color: "#D4D4D4", // Booleans
    },
    null: {
      color: "#D4D4D4", // null
    },
    punctuation: {
      color: "#E434BB", // Brackets, commas, colons
    },
    ".token.punctuation": {
      color: "#E434BB",
    },
    ".token.property": {
      color: "#FE9F6D",
    },
    ".token.string": {
      color: "#D4D4D4",
    },
    ".token.number": {
      color: "#D4D4D4",
    },
    ".token.boolean": {
      color: "#D4D4D4",
    },
    ".token.null": {
      color: "#D4D4D4",
    },
  };

  return (
    <div className="relative h-full w-full">
      {!isEditing && (
        <div
          className="absolute inset-0 overflow-auto cursor-text"
          onClick={() => setIsEditing(true)}
        >
          <SyntaxHighlighter
            language="json"
            style={customStyle}
            customStyle={{
              background: "transparent",
              margin: 0,
              padding: "16px",
            }}
            codeTagProps={{
              style: {
                fontFamily: '"Monaco", "Menlo", "Ubuntu Mono", "Consolas", monospace',
                fontSize: "13px",
              },
            }}
          >
            {value || "{}"}
          </SyntaxHighlighter>
        </div>
      )}

      {isEditing && (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={() => setIsEditing(false)}
          autoFocus
          className={`absolute inset-0 w-full h-full p-4 resize-none font-mono text-sm bg-transparent border-0 outline-none ${
            isValid ? "" : "border-rose-500"
          }`}
          style={{
            color: "#D4D4D4",
            fontFamily: '"Monaco", "Menlo", "Ubuntu Mono", "Consolas", monospace',
            fontSize: "13px",
            lineHeight: "1.6",
            whiteSpace: "pre",
            tabSize: 2,
          }}
          spellCheck={false}
          placeholder="Character JSON will appear here..."
        />
      )}
    </div>
  );
}
