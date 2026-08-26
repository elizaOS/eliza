"use client";

/**
 * Syntax-highlighted read-only code block (Prism vsc-dark-plus) for docs/snippets.
 */
import { type HTMLAttributes, memo } from "react";
import vscDarkPlus from "react-syntax-highlighter/dist/esm/styles/prism/vsc-dark-plus";
import { Card } from "../../../components/ui/card";
import { cn } from "../../lib/utils";
import { SyntaxHighlighter } from "./prism-light";

function FocusableCodePre(props: HTMLAttributes<HTMLElement>) {
  return (
    <section
      {...props}
      aria-label="Code"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: overflowing code requires a keyboard scroll entry point
      tabIndex={0}
    />
  );
}

export interface CodeDisplayProps {
  code: string;
  language?: string;
  className?: string;
}

/**
 * SYNTAX_HIGHLIGHT_PALETTE — DOCUMENTED DESIGN-SYSTEM EXCEPTION.
 *
 * Per DESIGN-SYSTEM.md §10.5, syntax-highlight token colors are semantic
 * constants and are exempt from the raw-hex ban. They intentionally use a
 * fixed VS Code (Dark+) palette so highlighted code reads correctly and
 * consistently regardless of the app theme. All values are consolidated in
 * this single named map (not scattered inline). The CHROME around the code
 * block (container border / background) is fully tokenized below.
 */
const SYNTAX_HIGHLIGHT_PALETTE = {
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
} as const;

const codeCustomStyle = {
  margin: 0,
  padding: "16px",
  background: "transparent",
  fontSize: "13px",
  lineHeight: "1.6",
};

export const CodeDisplay = memo(function CodeDisplay({
  code,
  language = "bash",
  className,
}: CodeDisplayProps) {
  return (
    <Card variant="panel" className={cn("overflow-hidden", className)}>
      <div>
        <SyntaxHighlighter
          language={language}
          style={SYNTAX_HIGHLIGHT_PALETTE}
          customStyle={codeCustomStyle}
          wrapLongLines={false}
          showLineNumbers={false}
          PreTag={FocusableCodePre}
        >
          {code}
        </SyntaxHighlighter>
      </div>
    </Card>
  );
});
