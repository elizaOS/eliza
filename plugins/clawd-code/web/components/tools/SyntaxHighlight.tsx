"use client";

import { useEffect, useState, useRef } from "react";
import type { Highlighter } from "shiki";

// Singleton highlighter promise so we only init once
let highlighterPromise: Promise<Highlighter> | null = null;

async function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = import("shiki").then((shiki) =>
      shiki.createHighlighter({
        themes: ["github-dark", "github-light"],
        langs: [
          "typescript",
          "javascript",
          "tsx",
          "jsx",
          "python",
          "rust",
          "go",
          "java",
          "c",
          "cpp",
          "ruby",
          "shell",
          "bash",
          "json",
          "yaml",
          "toml",
          "css",
          "html",
          "markdown",
          "sql",
          "dockerfile",
          "kotlin",
          "swift",
          "php",
          "xml",
        ],
      })
    );
  }
  return highlighterPromise;
}

// Map file extension to shiki language
const EXT_TO_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  rs: "rust",
  go: "go",
  java: "java",
  c: "c",
  cpp: "cpp",
  h: "c",
  hpp: "cpp",
  rb: "ruby",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  json: "json",
  jsonc: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  css: "css",
  scss: "css",
  html: "html",
  htm: "html",
  md: "markdown",
  mdx: "markdown",
  sql: "sql",
  kt: "kotlin",
  swift: "swift",
  php: "php",
  xml: "xml",
  dockerfile: "dockerfile",
};

export function getLanguageFromPath(filePath: string): string {
  const name = filePath.split("/").pop() ?? "";
  if (name.toLowerCase() === "dockerfile") return "dockerfile";
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return EXT_TO_LANG[ext] ?? "text";
}

interface UseHighlightedCodeOptions {
  code: string;
  lang: string;
  theme?: "github-dark" | "github-light";
}

export function useHighlightedCode({
  code,
  lang,
  theme = "github-dark",
}: UseHighlightedCodeOptions): string | null {
  const [html, setHtml] = useState<string | null>(null);
  const lastKey = useRef<string>("");
  const key = `${lang}:${theme}:${code}`;

  useEffect(() => {
    if (lastKey.current === key) return;
    lastKey.current = key;

    let cancelled = false;
    getHighlighter().then((hl) => {
      if (cancelled) return;
      try {
        const highlighted = hl.codeToHtml(code, { lang, theme });
        if (!cancelled) setHtml(highlighted);
      } catch {
        // Language not supported — fall back to plain
        if (!cancelled) setHtml(null);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [key, code, lang, theme]);

  return html;
}

interface SyntaxHighlightProps {
  code: string;
  lang: string;
  theme?: "github-dark" | "github-light";
  className?: string;
}

export function SyntaxHighlight({
  code,
  lang,
  theme = "github-dark",
  className,
}: SyntaxHighlightProps) {
  const html = useHighlightedCode({ code, lang, theme });

  if (html) {
    return (
      <div
        className={className}
        // shiki wraps output in <pre><code> already
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  }

  return (
    <pre className={className}>
      <code>{code}</code>
    </pre>
  );
}
