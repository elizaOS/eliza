/**
 * Shared cursor movement and text manipulation utilities.
 *
 * These functions provide grapheme-aware cursor movement and text editing
 * operations that can be shared between Input and Editor components.
 */

import { getSegmenter, isPunctuationChar, isWhitespaceChar } from "../utils.js";

const segmenter = getSegmenter();

/**
 * Result of a cursor movement operation.
 */
export interface CursorPosition {
  /** New cursor position */
  cursor: number;
}

/**
 * Result of a text editing operation.
 */
export interface TextEditResult {
  /** Modified text */
  text: string;
  /** New cursor position */
  cursor: number;
}

/**
 * Move cursor one grapheme to the left.
 *
 * @param text - Full text content
 * @param cursor - Current cursor position
 * @returns New cursor position
 */
export function moveCursorLeft(text: string, cursor: number): number {
  if (cursor <= 0) {
    return 0;
  }

  const beforeCursor = text.slice(0, cursor);
  const graphemes = [...segmenter.segment(beforeCursor)];
  const lastGrapheme = graphemes[graphemes.length - 1];

  return cursor - (lastGrapheme ? lastGrapheme.segment.length : 1);
}

/**
 * Move cursor one grapheme to the right.
 *
 * @param text - Full text content
 * @param cursor - Current cursor position
 * @returns New cursor position
 */
export function moveCursorRight(text: string, cursor: number): number {
  if (cursor >= text.length) {
    return text.length;
  }

  const afterCursor = text.slice(cursor);
  const graphemes = [...segmenter.segment(afterCursor)];
  const firstGrapheme = graphemes[0];

  return cursor + (firstGrapheme ? firstGrapheme.segment.length : 1);
}

/**
 * Move cursor to the beginning of the previous word.
 *
 * Word boundaries are determined by:
 * - Whitespace characters
 * - Punctuation characters
 *
 * @param text - Full text content
 * @param cursor - Current cursor position
 * @returns New cursor position
 */
export function moveWordBackwards(text: string, cursor: number): number {
  if (cursor === 0) {
    return 0;
  }

  const textBeforeCursor = text.slice(0, cursor);
  const graphemes = [...segmenter.segment(textBeforeCursor)];
  let newCursor = cursor;

  const popGrapheme = (): number => {
    const g = graphemes.pop();
    return g ? g.segment.length : 0;
  };

  const peekSegment = (): string => {
    const last = graphemes[graphemes.length - 1];
    return last ? last.segment : "";
  };

  // Skip trailing whitespace
  while (graphemes.length > 0 && isWhitespaceChar(peekSegment())) {
    newCursor -= popGrapheme();
  }

  if (graphemes.length > 0) {
    if (isPunctuationChar(peekSegment())) {
      // Skip punctuation run
      while (graphemes.length > 0 && isPunctuationChar(peekSegment())) {
        newCursor -= popGrapheme();
      }
    } else {
      // Skip word run
      while (
        graphemes.length > 0 &&
        !isWhitespaceChar(peekSegment()) &&
        !isPunctuationChar(peekSegment())
      ) {
        newCursor -= popGrapheme();
      }
    }
  }

  return newCursor;
}

/**
 * Move cursor to the end of the next word.
 *
 * Word boundaries are determined by:
 * - Whitespace characters
 * - Punctuation characters
 *
 * @param text - Full text content
 * @param cursor - Current cursor position
 * @returns New cursor position
 */
export function moveWordForwards(text: string, cursor: number): number {
  if (cursor >= text.length) {
    return text.length;
  }

  const textAfterCursor = text.slice(cursor);
  const segments = segmenter.segment(textAfterCursor);
  const iterator = segments[Symbol.iterator]();
  let next = iterator.next();
  let newCursor = cursor;

  // Skip leading whitespace
  while (!next.done && isWhitespaceChar(next.value.segment)) {
    newCursor += next.value.segment.length;
    next = iterator.next();
  }

  if (!next.done) {
    const firstGrapheme = next.value.segment;
    if (isPunctuationChar(firstGrapheme)) {
      // Skip punctuation run
      while (!next.done && isPunctuationChar(next.value.segment)) {
        newCursor += next.value.segment.length;
        next = iterator.next();
      }
    } else {
      // Skip word run
      while (
        !next.done &&
        !isWhitespaceChar(next.value.segment) &&
        !isPunctuationChar(next.value.segment)
      ) {
        newCursor += next.value.segment.length;
        next = iterator.next();
      }
    }
  }

  return newCursor;
}

/**
 * Delete one grapheme backwards from cursor position.
 *
 * @param text - Full text content
 * @param cursor - Current cursor position
 * @returns Modified text and new cursor position
 */
export function deleteGraphemeBackward(
  text: string,
  cursor: number,
): TextEditResult {
  if (cursor <= 0) {
    return { text, cursor: 0 };
  }

  const beforeCursor = text.slice(0, cursor);
  const graphemes = [...segmenter.segment(beforeCursor)];
  const lastGrapheme = graphemes[graphemes.length - 1];
  const graphemeLength = lastGrapheme ? lastGrapheme.segment.length : 1;

  return {
    text: text.slice(0, cursor - graphemeLength) + text.slice(cursor),
    cursor: cursor - graphemeLength,
  };
}

/**
 * Delete one grapheme forwards from cursor position.
 *
 * @param text - Full text content
 * @param cursor - Current cursor position
 * @returns Modified text and new cursor position
 */
export function deleteGraphemeForward(
  text: string,
  cursor: number,
): TextEditResult {
  if (cursor >= text.length) {
    return { text, cursor };
  }

  const afterCursor = text.slice(cursor);
  const graphemes = [...segmenter.segment(afterCursor)];
  const firstGrapheme = graphemes[0];
  const graphemeLength = firstGrapheme ? firstGrapheme.segment.length : 1;

  return {
    text: text.slice(0, cursor) + text.slice(cursor + graphemeLength),
    cursor,
  };
}

/**
 * Delete word backwards from cursor position.
 *
 * @param text - Full text content
 * @param cursor - Current cursor position
 * @returns Modified text and new cursor position
 */
export function deleteWordBackward(
  text: string,
  cursor: number,
): TextEditResult {
  if (cursor === 0) {
    return { text, cursor: 0 };
  }

  const newCursor = moveWordBackwards(text, cursor);
  return {
    text: text.slice(0, newCursor) + text.slice(cursor),
    cursor: newCursor,
  };
}

/**
 * Delete from cursor to the start of the line.
 *
 * @param text - Full text content
 * @param cursor - Current cursor position
 * @returns Modified text and new cursor position
 */
export function deleteToLineStart(
  text: string,
  cursor: number,
): TextEditResult {
  return {
    text: text.slice(cursor),
    cursor: 0,
  };
}

/**
 * Delete from cursor to the end of the line.
 *
 * @param text - Full text content
 * @param cursor - Current cursor position
 * @returns Modified text and new cursor position
 */
export function deleteToLineEnd(text: string, cursor: number): TextEditResult {
  return {
    text: text.slice(0, cursor),
    cursor,
  };
}

/**
 * Insert text at cursor position.
 *
 * @param text - Full text content
 * @param cursor - Current cursor position
 * @param insertText - Text to insert
 * @returns Modified text and new cursor position
 */
export function insertTextAtCursor(
  text: string,
  cursor: number,
  insertText: string,
): TextEditResult {
  return {
    text: text.slice(0, cursor) + insertText + text.slice(cursor),
    cursor: cursor + insertText.length,
  };
}

/**
 * Check if a character is a control character that should be rejected.
 * Control characters include C0 (0x00-0x1F), DEL (0x7F), and C1 (0x80-0x9F).
 *
 * @param char - Character to check
 * @returns True if the character is a control character
 */
export function isControlChar(char: string): boolean {
  const code = char.charCodeAt(0);
  return code < 32 || code === 0x7f || (code >= 0x80 && code <= 0x9f);
}

/**
 * Check if input data contains any control characters.
 *
 * @param data - Input string to check
 * @returns True if any control characters are present
 */
export function hasControlChars(data: string): boolean {
  return [...data].some(isControlChar);
}
