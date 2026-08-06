"use client";

import { useEffect, useRef } from "react";
import { parseKey, matchesEvent } from "@/lib/keyParser";
import { useCommandRegistry } from "./useCommandRegistry";

const SEQUENCE_TIMEOUT_MS = 1000;

/** Tags whose focus should suppress non-global shortcuts */
const INPUT_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (INPUT_TAGS.has(el.tagName)) return true;
  if (el.isContentEditable) return true;
  return false;
}

/**
 * Attaches a global keydown listener that fires registered commands.
 * Supports single combos ("mod+k") and two-key sequences ("g d").
 * Must be used inside a CommandRegistryProvider.
 */
export function useKeyboardShortcuts() {
  const { commandsRef } = useCommandRegistry();
  const pendingSequenceRef = useRef<string | null>(null);
  const sequenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const clearSequence = () => {
      pendingSequenceRef.current = null;
      if (sequenceTimerRef.current) {
        clearTimeout(sequenceTimerRef.current);
        sequenceTimerRef.current = null;
      }
    };

    const handler = (e: KeyboardEvent) => {
      // Ignore bare modifier keypresses
      if (["Meta", "Control", "Shift", "Alt"].includes(e.key)) return;

      const inInput = isTypingTarget(e.target);
      const commands = commandsRef.current;

      // --- Sequence matching (e.g. "g" then "d") ---
      if (pendingSequenceRef.current) {
        const seq = `${pendingSequenceRef.current} ${e.key.toLowerCase()}`;
        const match = commands.find(
          (cmd) =>
            (!inInput || cmd.global) &&
            (!cmd.when || cmd.when()) &&
            cmd.keys.includes(seq)
        );
        clearSequence();
        if (match) {
          e.preventDefault();
          match.action();
          return;
        }
      }

      // --- Single combo matching ---
      const singleMatch = commands.find((cmd) => {
        if (inInput && !cmd.global) return false;
        if (cmd.when && !cmd.when()) return false;
        return cmd.keys.some((k) => {
          // Sequence keys contain a space; skip them in the single pass
          if (k.includes(" ")) return false;
          return matchesEvent(parseKey(k), e);
        });
      });

      if (singleMatch) {
        e.preventDefault();
        singleMatch.action();
        return;
      }

      // --- Start-of-sequence detection (single bare key that starts a sequence) ---
      // Only when not in an input and no modifier held
      if (!inInput && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const keyLower = e.key.toLowerCase();
        const startsSequence = commands.some((cmd) =>
          cmd.keys.some((k) => k.includes(" ") && k.startsWith(keyLower + " "))
        );
        if (startsSequence) {
          e.preventDefault();
          clearSequence();
          pendingSequenceRef.current = keyLower;
          sequenceTimerRef.current = setTimeout(clearSequence, SEQUENCE_TIMEOUT_MS);
        }
      }
    };

    document.addEventListener("keydown", handler);
    return () => {
      document.removeEventListener("keydown", handler);
      clearSequence();
    };
  }, [commandsRef]);
}
