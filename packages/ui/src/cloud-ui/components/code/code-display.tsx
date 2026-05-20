"use client";

import vscDarkPlus from "react-syntax-highlighter/dist/esm/styles/prism/vsc-dark-plus";
import { cn } from "../../lib/utils";
import { SyntaxHighlighter } from "./prism-light";

export interface CodeDisplayProps {
  code: string;
  language?: string;
  className?: string;
}

const elizaCodeTheme = {
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

export function CodeDisplay({
  code,
  language = "bash",
  className,
}: CodeDisplayProps) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-none border border-white/10 bg-black/60",
        className,
      )}
    >
      <div className="overflow-x-auto">
        <SyntaxHighlighter
          language={language}
          style={elizaCodeTheme}
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
