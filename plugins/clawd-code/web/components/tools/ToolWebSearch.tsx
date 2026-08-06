"use client";

import { ExternalLink, Search } from "lucide-react";
import { ToolUseBlock } from "./ToolUseBlock";

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

interface ToolWebSearchProps {
  input: {
    query: string;
  };
  result?: string;
  isError?: boolean;
  isRunning?: boolean;
  startedAt?: number;
  completedAt?: number;
}

function parseSearchResults(result: string): SearchResult[] {
  // Try JSON first
  try {
    const data = JSON.parse(result);
    if (Array.isArray(data)) {
      return data.map((item) => ({
        title: item.title ?? item.name ?? "(no title)",
        url: item.url ?? item.link ?? "",
        snippet: item.snippet ?? item.description ?? item.content ?? "",
      }));
    }
    if (data.results) return parseSearchResults(JSON.stringify(data.results));
  } catch {
    // not JSON
  }

  // Fallback: treat raw text as a single result
  return [{ title: "Search Result", url: "", snippet: result }];
}

export function ToolWebSearch({
  input,
  result,
  isError = false,
  isRunning = false,
  startedAt,
  completedAt,
}: ToolWebSearchProps) {
  const results = result && !isError ? parseSearchResults(result) : [];

  return (
    <ToolUseBlock
      toolName="websearch"
      toolInput={input}
      toolResult={result}
      isError={isError}
      isRunning={isRunning}
      startedAt={startedAt}
      completedAt={completedAt}
    >
      {/* Query header */}
      <div className="flex items-center gap-2 px-3 py-2 bg-surface-850 border-b border-surface-700/50">
        <Search className="w-3.5 h-3.5 text-surface-500 flex-shrink-0" />
        <span className="text-sm text-surface-200 flex-1">{input.query}</span>
        {!isRunning && results.length > 0 && (
          <span className="text-xs text-surface-500">
            {results.length} result{results.length !== 1 ? "s" : ""}
          </span>
        )}
      </div>

      {/* Results */}
      {isRunning ? (
        <div className="px-3 py-4 text-surface-500 text-xs animate-pulse">
          Searching…
        </div>
      ) : isError ? (
        <div className="px-3 py-3 text-red-400 text-xs font-mono">{result}</div>
      ) : results.length === 0 ? (
        <div className="px-3 py-3 text-surface-500 text-xs">No results.</div>
      ) : (
        <div className="overflow-auto max-h-[480px] divide-y divide-surface-700/40">
          {results.map((r, i) => (
            <div key={i} className="px-3 py-3 hover:bg-surface-800/30 transition-colors">
              {r.url ? (
                <a
                  href={r.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="group flex flex-col gap-1"
                >
                  <div className="flex items-center gap-1">
                    <span className="text-sm font-medium text-brand-400 group-hover:text-brand-300 group-hover:underline">
                      {r.title}
                    </span>
                    <ExternalLink className="w-3 h-3 text-surface-500 flex-shrink-0" />
                  </div>
                  <span className="text-xs text-surface-500 truncate">{r.url}</span>
                </a>
              ) : (
                <span className="text-sm font-medium text-surface-200">{r.title}</span>
              )}
              {r.snippet && (
                <p className="mt-1 text-xs text-surface-400 leading-relaxed line-clamp-3">
                  {r.snippet}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </ToolUseBlock>
  );
}
