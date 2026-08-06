import type { TextareaRenderable } from "@opentui/core";
import { useCallback, useEffect, useRef, useState } from "react";
import type { FileIndex } from "../../utils/file-index.js";

const AT_TOKEN_RE = /(^|\s)@([\w\-./\\~][\w\-./\\~:]*|"[^"]*"?)$/u;
const BARE_PATH_RE = /(^|\s)(\.{0,2}\/[\w\-./\\~]*|[\w-]+\/[\w\-./\\~]*)$/u;

export interface TypeaheadState {
  suggestions: string[];
  selectedIndex: number;
  visible: boolean;
  accept: () => void;
  dismiss: () => void;
  navigateUp: () => void;
  navigateDown: () => void;
}

export interface TokenInfo {
  token: string;
  startPos: number;
  endPos: number;
  hasAtPrefix: boolean;
}

function extractToken(text: string, cursorPos: number): TokenInfo | null {
  const before = text.slice(0, cursorPos);

  const atMatch = before.match(AT_TOKEN_RE);
  if (atMatch) {
    const fullMatch = atMatch[0];
    const leading = atMatch[1] ?? "";
    const token = atMatch[2] ?? "";
    const startPos = before.length - fullMatch.length + leading.length;
    return { token, startPos, endPos: cursorPos, hasAtPrefix: true };
  }

  const bareMatch = before.match(BARE_PATH_RE);
  if (bareMatch) {
    const fullMatch = bareMatch[0];
    const leading = bareMatch[1] ?? "";
    const token = bareMatch[2] ?? "";
    if (!token.includes("/")) return null;
    const startPos = before.length - fullMatch.length + leading.length;
    return { token, startPos, endPos: cursorPos, hasAtPrefix: false };
  }

  return null;
}

export function useTypeahead(
  inputRef: React.RefObject<TextareaRenderable | null>,
  fileIndex: FileIndex | null,
  onAccept?: (filePath: string, tokenInfo: TokenInfo) => void,
): TypeaheadState {
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const tokenRef = useRef<TokenInfo | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastTextRef = useRef("");
  const lastCursorRef = useRef<number | null>(null);
  const onAcceptRef = useRef(onAccept);
  onAcceptRef.current = onAccept;

  const dismiss = useCallback(() => {
    setSuggestions([]);
    setSelectedIndex(0);
    tokenRef.current = null;
  }, []);

  const accept = useCallback(() => {
    const ta = inputRef.current;
    const token = tokenRef.current;
    if (!ta || !token || suggestions.length === 0) return;

    const selected = suggestions[selectedIndex] ?? suggestions[0];
    if (!selected) return;

    if (onAcceptRef.current) {
      onAcceptRef.current(selected, token);
    } else {
      const text = ta.plainText;
      const before = text.slice(0, token.startPos);
      const after = text.slice(token.endPos);
      const needsQuotes = selected.includes(" ");
      const replacement = needsQuotes ? `@"${selected}" ` : `@${selected} `;
      const newText = before + replacement + after;
      ta.setText(newText);
      ta.cursorOffset = before.length + replacement.length;
    }

    dismiss();
  }, [inputRef, suggestions, selectedIndex, dismiss]);

  const navigateUp = useCallback(() => {
    setSelectedIndex((prev) => (prev > 0 ? prev - 1 : suggestions.length - 1));
  }, [suggestions.length]);

  const navigateDown = useCallback(() => {
    setSelectedIndex((prev) => (prev < suggestions.length - 1 ? prev + 1 : 0));
  }, [suggestions.length]);

  useEffect(() => {
    if (!fileIndex) return;

    const poll = () => {
      const ta = inputRef.current;
      if (!ta) return;

      const text = ta.plainText;
      const cursor = ta.cursorOffset;

      if (text === lastTextRef.current && cursor === lastCursorRef.current && tokenRef.current) return;
      lastTextRef.current = text;
      lastCursorRef.current = cursor;

      const token = extractToken(text, cursor);
      if (!token || token.token.length === 0) {
        if (suggestions.length > 0) dismiss();
        return;
      }

      tokenRef.current = token;
      const searchQuery = token.token.replace(/^@/, "").replace(/^"/, "").replace(/"$/, "");

      fileIndex.match(searchQuery, 8).then((results) => {
        setSuggestions(results);
        setSelectedIndex(0);
      });
    };

    pollRef.current = setInterval(poll, 100);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [fileIndex, inputRef, dismiss, suggestions.length]);

  return {
    suggestions,
    selectedIndex,
    visible: suggestions.length > 0,
    accept,
    dismiss,
    navigateUp,
    navigateDown,
  };
}
