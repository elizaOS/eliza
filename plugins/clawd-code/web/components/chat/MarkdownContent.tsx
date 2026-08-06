"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

interface MarkdownContentProps {
  content: string;
  className?: string;
}

export function MarkdownContent({ content, className }: MarkdownContentProps) {
  return (
    <div
      className={cn(
        "prose prose-sm prose-invert max-w-none",
        "prose-p:leading-relaxed prose-p:my-1",
        "prose-pre:bg-surface-900 prose-pre:border prose-pre:border-surface-700",
        "prose-code:text-brand-300 prose-code:bg-surface-900 prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:text-xs",
        "prose-pre:code:bg-transparent prose-pre:code:text-surface-100 prose-pre:code:p-0",
        "prose-ul:my-1 prose-ol:my-1 prose-li:my-0.5",
        "prose-headings:text-surface-100 prose-headings:font-semibold",
        "prose-a:text-brand-400 prose-a:no-underline hover:prose-a:underline",
        "prose-blockquote:border-brand-500 prose-blockquote:text-surface-300",
        "prose-hr:border-surface-700",
        className
      )}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  );
}
