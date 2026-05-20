'use client';

import { cn } from '@feed/shared';
import { useRouter } from 'next/navigation';
import { type ComponentProps, memo, useCallback, useMemo } from 'react';
import { Streamdown } from 'streamdown';

type ResponseProps = ComponentProps<typeof Streamdown> & {
  onTagClick?: (tag: string) => void;
  /**
   * List of valid usernames for @mention formatting.
   * When provided, only @username where username is in this list will be formatted.
   * When not provided, all @mentions are formatted (backward compatible).
   * Case-sensitive matching.
   */
  validMentions?: string[];
};

/**
 * Pre-processes text to convert @mentions and $cashtags into markdown links.
 * These links use special protocols that are intercepted on click.
 *
 * @mentions -> [mention](feed://mention/username) (only if in validMentions)
 * $cashtags -> [cashtag](feed://cashtag/SYMBOL)
 *
 * @param text - The text to process
 * @param validMentions - Optional list of valid usernames (case-sensitive)
 */
function preprocessTags(text: string, validMentions?: Set<string>): string {
  if (!text || typeof text !== 'string') return text || '';

  // Match @mentions and $cashtags (excluding prices like $120k, $19.99)
  // @mentions: followed by word characters and hyphens
  // $cashtags: only match if followed by letters (not numbers)
  return text.replace(
    /(@[\w-]+)|(\$[A-Za-z][\w]*)/g,
    (match, mention, cashtag) => {
      if (mention) {
        const username = mention.slice(1); // Remove @
        // If validMentions is provided, only format if username is in the set
        if (validMentions && !validMentions.has(username)) {
          return match; // Keep as plain text
        }
        // @username -> [@username](feed://mention/username)
        return `[${mention}](feed://mention/${username})`;
      }
      if (cashtag) {
        // $BTC -> [$BTC](feed://cashtag/BTC)
        const symbol = cashtag.slice(1); // Remove $
        return `[${cashtag}](feed://cashtag/${symbol})`;
      }
      return match;
    }
  );
}

/**
 * Markdown response component using streamdown with social tag support.
 *
 * Renders markdown content with proper styling for:
 * - Links (blue, underlined, accessible)
 * - Code blocks
 * - Lists
 * - Headers
 * - @mentions and $cashtags (clickable, navigates to profile/token page)
 *
 * When `validMentions` is provided, only @mentions matching those usernames
 * will be formatted as links. This is useful in chat contexts where only
 * chat participants should be highlighted.
 *
 * @example
 * ```tsx
 * <Response
 *   validMentions={['john', 'tcm_elizalabs']}
 *   onTagClick={(tag) => console.log('Clicked:', tag)}
 * >
 *   Check out @john and $BTC for **great** returns!
 * </Response>
 * ```
 */
export const Response = memo(
  ({
    className,
    children,
    onTagClick,
    validMentions,
    ...props
  }: ResponseProps) => {
    const router = useRouter();

    // Convert validMentions array to Set for O(1) lookup
    const validMentionsSet = useMemo(() => {
      return validMentions ? new Set(validMentions) : undefined;
    }, [validMentions]);

    const handleClick = useCallback(
      (e: React.MouseEvent<HTMLDivElement>) => {
        const target = e.target as HTMLElement;

        // Check if clicked element is a link with our special protocol
        if (target.tagName === 'A') {
          const href = target.getAttribute('href');
          if (href?.startsWith('feed://')) {
            e.preventDefault();
            e.stopPropagation();

            const url = new URL(href);
            const type = url.host; // 'mention' or 'cashtag'
            const value = url.pathname.slice(1); // Remove leading /

            if (type === 'mention') {
              const tag = `@${value}`;
              if (onTagClick) {
                onTagClick(tag);
              } else {
                // Default: navigate to profile
                router.push(`/profile/${value}`);
              }
            } else if (type === 'cashtag') {
              const tag = `$${value}`;
              if (onTagClick) {
                onTagClick(tag);
              } else {
                // Default: navigate to token page
                router.push(`/tokens/${value}`);
              }
            }
          }
        }
      },
      [onTagClick, router]
    );

    // Pre-process children if it's a string
    const processedChildren =
      typeof children === 'string'
        ? preprocessTags(children, validMentionsSet)
        : children;

    return (
      <div onClick={handleClick}>
        <Streamdown
          className={cn(
            '[&>*:first-child]:mt-0 [&>*:last-child]:mb-0',
            // Prose-like styling
            '[&_p]:leading-relaxed',
            '[&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-4',
            '[&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-4',
            '[&_li]:my-1',
            // Headers
            '[&_h1]:mt-4 [&_h1]:mb-2 [&_h1]:font-bold [&_h1]:text-xl',
            '[&_h2]:mt-3 [&_h2]:mb-2 [&_h2]:font-semibold [&_h2]:text-lg',
            '[&_h3]:mt-2 [&_h3]:mb-1 [&_h3]:font-medium [&_h3]:text-base',
            // Code
            '[&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-sm',
            '[&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-muted [&_pre]:p-3',
            '[&_pre_code]:bg-transparent [&_pre_code]:p-0',
            // Tag links - styled like TaggedText
            '[&_a[href^="feed://"]]:cursor-pointer [&_a[href^="feed://"]]:font-medium',
            '[&_a[href^="feed://"]]:text-[#0066FF] hover:[&_a[href^="feed://"]]:text-[#2952d9]',
            '[&_a[href^="feed://"]]:underline [&_a[href^="feed://"]]:decoration-[#0066FF]/30',
            'hover:[&_a[href^="feed://"]]:decoration-[#0066FF]/50',
            // Regular links - high-contrast, accessible styles
            '[&_a:not([href^="feed://"])]:font-medium [&_a:not([href^="feed://"])]:underline [&_a:not([href^="feed://"])]:underline-offset-2',
            '[&_a:not([href^="feed://"])]:text-blue-600 dark:[&_a:not([href^="feed://"])]:text-blue-400',
            'hover:[&_a:not([href^="feed://"])]:text-blue-500 dark:hover:[&_a:not([href^="feed://"])]:text-blue-300',
            '[&_a:not([href^="feed://"])]:decoration-blue-500/50 hover:[&_a:not([href^="feed://"])]:decoration-2 dark:[&_a:not([href^="feed://"])]:decoration-blue-400/60',
            'focus-visible:[&_a:not([href^="feed://"])]:rounded-sm focus-visible:[&_a:not([href^="feed://"])]:outline-none focus-visible:[&_a:not([href^="feed://"])]:ring-1 focus-visible:[&_a:not([href^="feed://"])]:ring-blue-400/40',
            '[&_a:not([href^="feed://"])]:break-words',
            // Blockquote
            '[&_blockquote]:my-2 [&_blockquote]:border-muted-foreground/30 [&_blockquote]:border-l-4 [&_blockquote]:pl-4 [&_blockquote]:italic',
            // Tables - contained with horizontal scroll
            '[&_table]:my-2 [&_table]:w-full [&_table]:border-collapse [&_table]:text-sm',
            '[&_th]:border [&_th]:border-border [&_th]:bg-muted/50 [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_th]:font-semibold',
            '[&_td]:border [&_td]:border-border [&_td]:px-3 [&_td]:py-2',
            '[&_.table-wrapper]:max-w-full [&_.table-wrapper]:overflow-x-auto',
            // Strong/Bold
            '[&_strong]:font-semibold',
            // Horizontal rule
            '[&_hr]:my-4 [&_hr]:border-border',
            className
          )}
          {...props}
        >
          {processedChildren}
        </Streamdown>
      </div>
    );
  },
  (prevProps, nextProps) =>
    prevProps.children === nextProps.children &&
    prevProps.onTagClick === nextProps.onTagClick &&
    prevProps.validMentions === nextProps.validMentions
);

Response.displayName = 'Response';
