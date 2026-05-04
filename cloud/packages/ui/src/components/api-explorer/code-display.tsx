/**
 * Code display component with syntax highlighting using Prism.
 * Provides custom theme matching application design system.
 *
 * @param props - Code display configuration
 * @param props.code - Code string to display
 * @param props.language - Programming language for syntax highlighting
 * @param props.className - Additional CSS classes
 */

"use client";

import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { vscDarkPlus } from "react-syntax-highlighter/dist/esm/styles/prism";

interface CodeDisplayProps {
  code: string;
  language?: string;
  className?: string;
}

export function CodeDisplay({ code, language = "bash", className = "" }: CodeDisplayProps) {
  // Custom theme based on Eliza's design system
  const _customStyle = {
    ...vscDarkPlus,
    'pre[class*="language-"]': {
      background: "transparent",
      padding: 0,
      margin: 0,
      fontSize: "13px",
      lineHeight: "1.6",
      fontFamily: '"Monaco", "Menlo", "Ubuntu Mono", "Consolas", monospace',
    },
    'code[class*="language-"]': {
      background: "transparent",
      fontSize: "13px",
      lineHeight: "1.6",
      fontFamily: '"Monaco", "Menlo", "Ubuntu Mono", "Consolas", monospace',
    },
  };

  // Custom token colors matching Eliza theme
  const customTokenColors = {
    ...vscDarkPlus,
    comment: { color: "#6A9955" },
    prolog: { color: "#6A9955" },
    doctype: { color: "#6A9955" },
    cdata: { color: "#6A9955" },
    punctuation: { color: "#D4D4D4" },
    property: { color: "#9CDCFE" },
    tag: { color: "#569CD6" },
    boolean: { color: "#569CD6" },
    number: { color: "#B5CEA8" },
    constant: { color: "#4FC1FF" },
    symbol: { color: "#4FC1FF" },
    deleted: { color: "#CE9178" },
    selector: { color: "#D7BA7D" },
    "attr-name": { color: "#9CDCFE" },
    string: { color: "#CE9178" },
    char: { color: "#CE9178" },
    builtin: { color: "#4EC9B0" },
    inserted: { color: "#B5CEA8" },
    operator: { color: "#D4D4D4" },
    entity: { color: "#D7BA7D" },
    url: { color: "#3794FF" },
    variable: { color: "#9CDCFE" },
    atrule: { color: "#C586C0" },
    "attr-value": { color: "#CE9178" },
    function: { color: "#DCDCAA" },
    "class-name": { color: "#4EC9B0" },
    keyword: { color: "#C586C0" },
    regex: { color: "#D16969" },
    important: { color: "#569CD6", fontWeight: "bold" },
  };

  return (
    <div className={`rounded-none border border-white/10 bg-black/60 overflow-hidden ${className}`}>
      <div className="overflow-x-auto">
        <SyntaxHighlighter
          language={language}
          style={customTokenColors}
          customStyle={{
            margin: 0,
            padding: "16px",
            background: "transparent",
            fontSize: "13px",
            lineHeight: "1.6",
          }}
          wrapLongLines={false}
          showLineNumbers={false}
          PreTag="div"
        >
          {code}
        </SyntaxHighlighter>
      </div>
    </div>
  );
}
