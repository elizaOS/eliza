"use client";

/**
 * Web-adapted Markdown renderer.
 *
 * The terminal Markdown (src/components/Markdown.tsx) uses marked + Ink's
 * <Ansi> / <Box> to render tokenised markdown as coloured ANSI output.
 * This web version uses react-markdown + remark-gfm + rehype-highlight, which
 * are already present in the web package, to render proper HTML with Tailwind
 * prose styles.
 *
 * Props are intentionally compatible with the terminal version so callers can
 * swap between them via the platform conditional.
 */

import * as React from "react";
import { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface MarkdownProps {
  /** Markdown source string — matches the terminal component's children prop. */
  children: string;
  /** When true, render all text as visually dimmed (muted colour). */
  dimColor?: boolean;
  /** Extra class names applied to the prose wrapper. */
  className?: string;
}

// ─── Inline code / pre renderers ─────────────────────────────────────────────

function InlineCode({ children }: { children?: React.ReactNode }) {
  return (
    <code className="px-1 py-0.5 rounded text-xs font-mono bg-surface-850 text-brand-300 border border-surface-700">
      {children}
    </code>
  );
}

interface PreProps {
  children?: React.ReactNode;
}

function Pre({ children }: PreProps) {
  return (
    <pre className="overflow-x-auto rounded-md bg-surface-900 border border-surface-700 p-3 my-2 text-xs font-mono leading-relaxed">
      {children}
    </pre>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export function Markdown({ children, dimColor = false, className }: MarkdownProps) {
  // Memoised to avoid re-parsing on every parent render.
  const content = useMemo(() => children, [children]);

  return (
    <div
      className={cn(
        "markdown-body text-sm leading-relaxed font-mono",
        dimColor ? "text-surface-500" : "text-surface-100",

        // Headings
        "[&_h1]:text-base [&_h1]:font-bold [&_h1]:mb-2 [&_h1]:mt-3 [&_h1]:text-surface-50",
        "[&_h2]:text-sm [&_h2]:font-semibold [&_h2]:mb-1.5 [&_h2]:mt-2.5 [&_h2]:text-surface-100",
        "[&_h3]:text-sm [&_h3]:font-semibold [&_h3]:mb-1 [&_h3]:mt-2 [&_h3]:text-surface-200",

        // Paragraphs
        "[&_p]:my-1 [&_p]:leading-relaxed",

        // Lists
        "[&_ul]:my-1 [&_ul]:pl-4 [&_ul]:list-disc",
        "[&_ol]:my-1 [&_ol]:pl-4 [&_ol]:list-decimal",
        "[&_li]:my-0.5",

        // Blockquote
        "[&_blockquote]:border-l-2 [&_blockquote]:border-brand-500 [&_blockquote]:pl-3",
        "[&_blockquote]:my-2 [&_blockquote]:text-surface-400 [&_blockquote]:italic",

        // Horizontal rule
        "[&_hr]:border-surface-700 [&_hr]:my-3",

        // Tables (GFM)
        "[&_table]:w-full [&_table]:text-xs [&_table]:border-collapse [&_table]:my-2",
        "[&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_th]:border [&_th]:border-surface-700 [&_th]:bg-surface-800 [&_th]:font-semibold",
        "[&_td]:px-2 [&_td]:py-1 [&_td]:border [&_td]:border-surface-700",
        "[&_tr:nth-child(even)_td]:bg-surface-900/40",

        // Links
        "[&_a]:text-brand-400 [&_a]:no-underline [&_a:hover]:underline",

        // Strong / em
        "[&_strong]:font-bold [&_strong]:text-surface-50",
        "[&_em]:italic",

        className
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code({ className: cls, children: codeChildren, ...rest }) {
            const isBlock = /language-/.test(cls ?? "");
            if (isBlock) {
              return (
                <code className={cn("block text-surface-200", cls)} {...rest}>
                  {codeChildren}
                </code>
              );
            }
            return <InlineCode {...rest}>{codeChildren}</InlineCode>;
          },
          pre: ({ children: preChildren }) => <Pre>{preChildren}</Pre>,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

// ─── Table component (matches MarkdownTable.tsx surface) ─────────────────────

export interface MarkdownTableProps {
  headers: string[];
  rows: string[][];
  className?: string;
}

export function MarkdownTable({ headers, rows, className }: MarkdownTableProps) {
  return (
    <div className={cn("overflow-x-auto my-2", className)}>
      <table className="w-full text-xs border-collapse font-mono">
        <thead>
          <tr>
            {headers.map((h, i) => (
              <th
                key={i}
                className="px-2 py-1 text-left border border-surface-700 bg-surface-800 font-semibold text-surface-200"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr key={ri}>
              {row.map((cell, ci) => (
                <td
                  key={ci}
                  className={cn(
                    "px-2 py-1 border border-surface-700 text-surface-300",
                    ri % 2 === 1 && "bg-surface-900/40"
                  )}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
