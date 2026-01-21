"use client";

import { cn } from "@polyagent/shared";

/**
 * Tagged text component for parsing and highlighting social tags.
 *
 * Parses and highlights @mentions and $cashtags in text.
 * Tags are clickable and styled in blue with hover effects. Handles
 * edge cases like null/undefined text and empty strings gracefully.
 * Note: Prices like $120k, $19.99 are NOT treated as cashtags.
 *
 * @param props - TaggedText component props
 * @returns Tagged text element with highlighted tags
 *
 * @example
 * ```tsx
 * <TaggedText
 *   text="Check out @username and $AAPL stock"
 *   onTagClick={(tag) => console.log('Clicked:', tag)}
 * />
 * ```
 */
interface TaggedTextProps {
  text: string;
  onTagClick?: (tag: string) => void;
  className?: string;
}

export function TaggedText({ text, onTagClick, className }: TaggedTextProps) {
  // Handle null, undefined, or non-string text - return plain text
  if (!text || typeof text !== "string") {
    return <span className={className}>{text || ""}</span>;
  }

  // Handle empty string
  if (text.length === 0) {
    return <span className={className}></span>;
  }

  // Regex to match @mentions and $cashtags (excluding prices)
  // @mentions: followed by word characters
  // $cashtags: only match if followed by letters (not numbers) to avoid matching prices like $120k, $19.99
  // Examples: @username, $AAPL, $BTC (but NOT $120k, $19.99)
  // Note: #hashtags are ignored - not used in the app
  const tagRegex = /(@[\w-]+)|(\$[A-Za-z][\w]*)/g;

  const parts: Array<{
    text: string;
    isTag: boolean;
    tagType?: "@" | "#" | "$";
  }> = [];
  let lastIndex = 0;
  let match;

  // Reset regex lastIndex to start from beginning
  tagRegex.lastIndex = 0;

  while ((match = tagRegex.exec(text)) !== null) {
    // Add text before the tag
    if (match.index > lastIndex) {
      parts.push({
        text: text.slice(lastIndex, match.index),
        isTag: false,
      });
    }

    // Add the tag - match[0] is the full match
    // match[1] = @mention, match[2] = #hashtag, match[3] = $cashtag
    const fullTag = match[0]; // e.g., "@username" or "#hashtag" or "$cashtag"
    const tagType = fullTag[0] as "@" | "#" | "$";
    parts.push({
      text: fullTag,
      isTag: true,
      tagType,
    });

    lastIndex = match.index + fullTag.length;
  }

  // Add remaining text after last tag (or all text if no tags found)
  if (lastIndex < text.length) {
    parts.push({
      text: text.slice(lastIndex),
      isTag: false,
    });
  }

  // If no tags found, return plain text
  if (parts.length === 0 || (parts.length === 1 && !parts[0]?.isTag)) {
    return <span className={className}>{text}</span>;
  }

  return (
    <span className={className}>
      {parts.map((part, index) => {
        if (part.isTag) {
          return (
            <span
              key={index}
              onClick={(e) => {
                e.stopPropagation();
                if (onTagClick) {
                  onTagClick(part.text);
                }
              }}
              className={cn(
                "cursor-pointer font-medium text-[#0066FF] hover:text-[#2952d9]",
                "transition-colors duration-150",
                "underline decoration-[#0066FF]/30 hover:decoration-[#0066FF]/50",
              )}
              style={{ color: "#0066FF" }}
            >
              {part.text}
            </span>
          );
        }
        return <span key={index}>{part.text}</span>;
      })}
    </span>
  );
}
