"use client";

import { useState, useEffect, useRef } from "react";
import { X, ChevronUp, ChevronDown, Regex, CaseSensitive } from "lucide-react";
import { cn } from "@/lib/utils";

interface SearchBarProps {
  content: string;
  containerRef: React.RefObject<HTMLDivElement>;
  onClose: () => void;
}

export function SearchBar({ content, containerRef, onClose }: SearchBarProps) {
  const [query, setQuery] = useState("");
  const [isRegex, setIsRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [currentMatch, setCurrentMatch] = useState(0);
  const [totalMatches, setTotalMatches] = useState(0);
  const [hasError, setHasError] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Compute matches
  useEffect(() => {
    if (!query) {
      setTotalMatches(0);
      setCurrentMatch(0);
      clearHighlights();
      return;
    }

    try {
      const flags = caseSensitive ? "g" : "gi";
      const pattern = isRegex ? new RegExp(query, flags) : new RegExp(escapeRegex(query), flags);
      const matches = Array.from(content.matchAll(pattern));
      setTotalMatches(matches.length);
      setCurrentMatch(matches.length > 0 ? 1 : 0);
      setHasError(false);
    } catch {
      setHasError(true);
      setTotalMatches(0);
      setCurrentMatch(0);
    }
  }, [query, isRegex, caseSensitive, content]);

  // Apply DOM highlights
  useEffect(() => {
    if (!containerRef.current) return;
    clearHighlights();

    if (!query || hasError || totalMatches === 0) return;

    try {
      const flags = caseSensitive ? "g" : "gi";
      const pattern = isRegex ? new RegExp(query, flags) : new RegExp(escapeRegex(query), flags);

      const walker = document.createTreeWalker(
        containerRef.current,
        NodeFilter.SHOW_TEXT,
        {
          acceptNode: (node) => {
            // Skip nodes inside already-marked elements
            if ((node.parentElement as HTMLElement)?.tagName === "MARK") {
              return NodeFilter.FILTER_REJECT;
            }
            return NodeFilter.FILTER_ACCEPT;
          },
        }
      );

      const textNodes: Text[] = [];
      let node: Text | null;
      while ((node = walker.nextNode() as Text | null)) {
        textNodes.push(node);
      }

      let matchIdx = 0;
      // Process in reverse order to avoid position shifting
      const replacements: { node: Text; ranges: { start: number; end: number; idx: number }[] }[] = [];

      for (const textNode of textNodes) {
        const text = textNode.textContent ?? "";
        pattern.lastIndex = 0;
        const nodeRanges: { start: number; end: number; idx: number }[] = [];
        let m: RegExpExecArray | null;
        while ((m = pattern.exec(text)) !== null) {
          nodeRanges.push({ start: m.index, end: m.index + m[0].length, idx: matchIdx++ });
          if (m[0].length === 0) break; // prevent infinite loop on zero-width matches
        }
        if (nodeRanges.length > 0) {
          replacements.push({ node: textNode, ranges: nodeRanges });
        }
      }

      // Apply replacements in document order but process ranges in reverse
      for (const { node: textNode, ranges } of replacements) {
        const text = textNode.textContent ?? "";
        const fragment = document.createDocumentFragment();
        let lastEnd = 0;

        for (const { start, end, idx } of ranges) {
          if (start > lastEnd) {
            fragment.appendChild(document.createTextNode(text.slice(lastEnd, start)));
          }
          const mark = document.createElement("mark");
          mark.className = cn(
            "search-highlight",
            idx === currentMatch - 1 ? "search-highlight-current" : ""
          );
          mark.textContent = text.slice(start, end);
          fragment.appendChild(mark);
          lastEnd = end;
        }
        if (lastEnd < text.length) {
          fragment.appendChild(document.createTextNode(text.slice(lastEnd)));
        }
        textNode.parentNode?.replaceChild(fragment, textNode);
      }

      // Scroll current match into view
      const currentEl = containerRef.current?.querySelector(".search-highlight-current");
      currentEl?.scrollIntoView({ block: "center", behavior: "smooth" });
    } catch {
      // Ignore DOM errors
    }

    return () => {
      if (containerRef.current) clearHighlights();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, isRegex, caseSensitive, currentMatch, totalMatches]);

  function clearHighlights() {
    if (!containerRef.current) return;
    const marks = containerRef.current.querySelectorAll("mark.search-highlight");
    marks.forEach((mark) => {
      mark.replaceWith(mark.textContent ?? "");
    });
    // Normalize text nodes
    containerRef.current.normalize();
  }

  const goNext = () => {
    setCurrentMatch((c) => (c >= totalMatches ? 1 : c + 1));
  };

  const goPrev = () => {
    setCurrentMatch((c) => (c <= 1 ? totalMatches : c - 1));
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.shiftKey ? goPrev() : goNext();
    }
    if (e.key === "Escape") {
      clearHighlights();
      onClose();
    }
  };

  return (
    <div className="flex items-center gap-1 px-2 py-1.5 border-b border-surface-800 bg-surface-900/90 backdrop-blur-sm">
      <div
        className={cn(
          "flex items-center gap-1 flex-1 bg-surface-800 rounded px-2 py-1",
          hasError && "ring-1 ring-red-500/50"
        )}
      >
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Search..."
          className="flex-1 bg-transparent text-xs text-surface-100 placeholder-surface-500 outline-none min-w-0"
        />

        {/* Match count */}
        {query && (
          <span className={cn(
            "text-xs flex-shrink-0",
            hasError ? "text-red-400" : totalMatches === 0 ? "text-red-400" : "text-surface-400"
          )}>
            {hasError ? "Invalid regex" : totalMatches === 0 ? "No results" : `${currentMatch}/${totalMatches}`}
          </span>
        )}

        {/* Toggles */}
        <button
          onClick={() => setCaseSensitive((v) => !v)}
          className={cn(
            "p-0.5 rounded transition-colors flex-shrink-0",
            caseSensitive
              ? "text-brand-400 bg-brand-900/40"
              : "text-surface-500 hover:text-surface-300"
          )}
          title="Case sensitive"
        >
          <CaseSensitive className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={() => setIsRegex((v) => !v)}
          className={cn(
            "p-0.5 rounded transition-colors flex-shrink-0",
            isRegex
              ? "text-brand-400 bg-brand-900/40"
              : "text-surface-500 hover:text-surface-300"
          )}
          title="Use regular expression"
        >
          <Regex className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Navigation */}
      <button
        onClick={goPrev}
        disabled={totalMatches === 0}
        className="p-1 rounded text-surface-500 hover:text-surface-200 hover:bg-surface-800 disabled:opacity-30 transition-colors"
        title="Previous match (Shift+Enter)"
      >
        <ChevronUp className="w-3.5 h-3.5" />
      </button>
      <button
        onClick={goNext}
        disabled={totalMatches === 0}
        className="p-1 rounded text-surface-500 hover:text-surface-200 hover:bg-surface-800 disabled:opacity-30 transition-colors"
        title="Next match (Enter)"
      >
        <ChevronDown className="w-3.5 h-3.5" />
      </button>

      <button
        onClick={() => { clearHighlights(); onClose(); }}
        className="p-1 rounded text-surface-500 hover:text-surface-200 hover:bg-surface-800 transition-colors"
        title="Close (Escape)"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
