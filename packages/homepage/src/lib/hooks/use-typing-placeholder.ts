/**
 * Hook for animated typing placeholder effect.
 * Types out sentences character by character, then deletes before moving to the next.
 */

import { useEffect, useState } from "react";

export function useTypingPlaceholder(
  sentences: string[],
  typingSpeed = 60,
  deletingSpeed = 20,
  pauseAfterTyping = 5000,
  pauseAfterDeleting = 500,
): string {
  const [placeholder, setPlaceholder] = useState("");
  const [sentenceIndex, setSentenceIndex] = useState(0);
  const [isTyping, setIsTyping] = useState(true);

  useEffect(() => {
    const currentSentence = sentences[sentenceIndex];
    let timeout: ReturnType<typeof setTimeout>;

    if (isTyping) {
      if (placeholder.length < currentSentence.length) {
        timeout = setTimeout(() => {
          setPlaceholder(currentSentence.slice(0, placeholder.length + 1));
        }, typingSpeed);
      } else {
        timeout = setTimeout(() => setIsTyping(false), pauseAfterTyping);
      }
    } else {
      if (placeholder.length > 0) {
        timeout = setTimeout(() => {
          setPlaceholder(placeholder.slice(0, -1));
        }, deletingSpeed);
      } else {
        timeout = setTimeout(() => {
          setSentenceIndex((prev) => (prev + 1) % sentences.length);
          setIsTyping(true);
        }, pauseAfterDeleting);
      }
    }

    return () => clearTimeout(timeout);
  }, [
    placeholder,
    sentenceIndex,
    isTyping,
    sentences,
    typingSpeed,
    deletingSpeed,
    pauseAfterTyping,
    pauseAfterDeleting,
  ]);

  return placeholder;
}
