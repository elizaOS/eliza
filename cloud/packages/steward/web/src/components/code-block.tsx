"use client";

import { motion, useInView } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { CopyButton } from "./copy-button";

interface CodeBlockProps {
  code: string;
  language?: string;
  filename?: string;
  typeEffect?: boolean;
  className?: string;
}

// Simple syntax coloring for TypeScript/JS — no external dep
function tokenize(code: string): { text: string; type: string }[] {
  const tokens: { text: string; type: string }[] = [];
  const patterns: [RegExp, string][] = [
    [/^(\/\/.*)/m, "comment"],
    [/^(["'`](?:[^"'`\\]|\\.)*["'`])/, "string"],
    [
      /^(\b(?:import|from|export|const|let|var|function|async|await|return|new|type|interface|class|extends|implements)\b)/,
      "keyword",
    ],
    [/^(\b(?:true|false|null|undefined|void)\b)/, "literal"],
    [/^(\b\d[\d_.]*\b)/, "number"],
    [/^([{}()[\];:,.<>=!+\-*/&|?@])/, "punctuation"],
    [/^(\b[A-Z][a-zA-Z0-9]*\b)/, "type"],
    [/^(\b[a-z_$][a-zA-Z0-9_$]*\b(?=\s*\())/, "function"],
    [/^(\b[a-zA-Z_$][a-zA-Z0-9_$]*\b)/, "identifier"],
    [/^(\s+)/, "whitespace"],
    [/^(.)/, "plain"],
  ];

  let remaining = code;
  while (remaining.length > 0) {
    let matched = false;
    for (const [pattern, type] of patterns) {
      const match = remaining.match(pattern);
      if (match) {
        tokens.push({ text: match[1], type });
        remaining = remaining.slice(match[1].length);
        matched = true;
        break;
      }
    }
    if (!matched) {
      tokens.push({ text: remaining[0], type: "plain" });
      remaining = remaining.slice(1);
    }
  }
  return tokens;
}

const tokenColors: Record<string, string> = {
  keyword: "text-[oklch(0.75_0.15_55)]",
  string: "text-[#a8b88a]",
  comment: "text-text-tertiary italic",
  number: "text-[#d4a276]",
  type: "text-[#c9a87c]",
  function: "text-[#d4bfa0]",
  literal: "text-[#d4a276]",
  punctuation: "text-text-tertiary",
  identifier: "text-text",
  whitespace: "",
  plain: "text-text",
};

export function CodeBlock({
  code,
  language = "typescript",
  filename,
  typeEffect = false,
  className = "",
}: CodeBlockProps) {
  const ref = useRef<HTMLDivElement>(null);
  const isInView = useInView(ref, { once: true, amount: 0.3 });
  const [visibleChars, setVisibleChars] = useState(typeEffect ? 0 : code.length);
  const tokens = tokenize(code);

  useEffect(() => {
    if (!typeEffect || !isInView) return;
    const totalChars = code.length;
    let current = 0;
    const interval = setInterval(() => {
      current += 2;
      if (current >= totalChars) {
        setVisibleChars(totalChars);
        clearInterval(interval);
      } else {
        setVisibleChars(current);
      }
    }, 12);
    return () => clearInterval(interval);
  }, [typeEffect, isInView, code]);

  function renderTokens() {
    let charCount = 0;
    return tokens.map((token, i) => {
      const start = charCount;
      charCount += token.text.length;
      if (typeEffect && start >= visibleChars) return null;
      const visibleText =
        typeEffect && charCount > visibleChars
          ? token.text.slice(0, visibleChars - start)
          : token.text;
      return (
        <span key={i} className={tokenColors[token.type] || ""}>
          {visibleText}
        </span>
      );
    });
  }

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: 12 }}
      animate={isInView ? { opacity: 1, y: 0 } : {}}
      transition={{ duration: 0.5, ease: [0.25, 1, 0.5, 1] }}
      className={`relative group ${className}`}
    >
      {filename && (
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-border-subtle bg-bg-elevated/50">
          <span className="text-xs text-text-tertiary font-mono">{filename}</span>
          <div className="flex items-center gap-2">
            {language && (
              <span className="text-[10px] uppercase tracking-widest text-text-tertiary">
                {language}
              </span>
            )}
            <CopyButton text={code} />
          </div>
        </div>
      )}
      <div className="relative">
        <pre className="p-5 overflow-x-auto text-sm leading-relaxed font-mono">
          <code>{renderTokens()}</code>
          {typeEffect && visibleChars < code.length && (
            <span className="inline-block w-[2px] h-[1.1em] bg-accent ml-[1px] animate-pulse align-text-bottom" />
          )}
        </pre>
        {!filename && (
          <div className="absolute top-3 right-3 opacity-0 group-hover:opacity-100 transition-opacity">
            <CopyButton text={code} />
          </div>
        )}
      </div>
    </motion.div>
  );
}
