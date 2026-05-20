'use client';

import type { CommentInputProps } from '@feed/shared';
import { cn } from '@feed/shared';
import { Send, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { useSocialTracking } from '@/hooks/usePostHog';
import { useInteractionStore } from '@/stores/interactionStore';

/**
 * Maximum allowed length for comment content.
 */
const MAX_COMMENT_LENGTH = 5000;

/**
 * Comment input component for writing and submitting comments.
 *
 * Provides a textarea input for writing comments with auto-resize,
 * character limit validation, and optimistic updates. Supports
 * both top-level comments and replies. Includes submit and cancel
 * actions with keyboard shortcuts (Enter to submit, Escape to cancel).
 *
 * @param props - CommentInput component props
 * @returns Comment input element
 *
 * @example
 * ```tsx
 * <CommentInput
 *   postId="post-123"
 *   parentCommentId="comment-456"
 *   placeholder="Write a reply..."
 *   onSubmit={handleSubmit}
 * />
 * ```
 */
export function CommentInput({
  postId,
  parentCommentId,
  placeholder = 'Write a comment...',
  autoFocus = false,
  onSubmit,
  onCancel,
  className,
  replyingToName,
}: CommentInputProps & { replyingToName?: string }) {
  const [content, setContent] = useState('');
  const [isFocused, setIsFocused] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [optimisticComment, setOptimisticComment] = useState<string | null>(
    null
  );
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const { authenticated, login } = useAuth();
  const { trackPostComment } = useSocialTracking();
  const { addComment } = useInteractionStore();

  useEffect(() => {
    if (autoFocus && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [autoFocus]);

  // Auto-resize textarea
  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = `${textarea.scrollHeight}px`;
    }
  }, []);

  const handleSubmit = async () => {
    if (!authenticated) {
      login();
      return;
    }

    const trimmedContent = content.trim();

    if (!trimmedContent || isSubmitting) {
      return;
    }

    if (trimmedContent.length > MAX_COMMENT_LENGTH) {
      return;
    }

    setIsSubmitting(true);

    // Show optimistic comment immediately
    setOptimisticComment(trimmedContent);

    // Clear input optimistically
    const originalContent = content;
    setContent('');
    setIsFocused(false);

    const comment = await addComment(postId, trimmedContent, parentCommentId);

    if (comment) {
      // Clear optimistic state on success
      setOptimisticComment(null);
      trackPostComment(postId, trimmedContent.length);

      // Call onSubmit callback if provided (await if it returns a promise)
      if (onSubmit) {
        await Promise.resolve(onSubmit(comment));
      }
    } else {
      // Restore content if failed
      setContent(originalContent);
      setOptimisticComment(null);
    }

    setIsSubmitting(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Submit on Enter (without Shift)
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }

    // Cancel on Escape
    if (e.key === 'Escape' && onCancel) {
      e.preventDefault();
      onCancel();
    }
  };

  const handleCancel = () => {
    setContent('');
    setIsFocused(false);
    if (onCancel) {
      onCancel();
    }
  };

  const remainingChars = MAX_COMMENT_LENGTH - content.length;
  const isOverLimit = remainingChars < 0;
  const showCharCount = content.length > MAX_COMMENT_LENGTH * 0.8;

  return (
    <>
      {/* Replying to indicator */}
      {replyingToName && (
        <div className="mb-2 flex items-center gap-1 text-muted-foreground text-sm">
          <span>Replying to</span>
          <span className="font-medium text-primary">@{replyingToName}</span>
        </div>
      )}

      {/* Optimistic comment preview */}
      {optimisticComment && (
        <div className="mb-2 rounded-lg border border-primary/50 bg-muted/30 p-3 opacity-60">
          <div className="mb-1 flex items-center gap-2">
            <span className="text-muted-foreground text-xs">Posting...</span>
          </div>
          <p className="whitespace-pre-wrap break-words text-foreground text-sm">
            {optimisticComment}
          </p>
        </div>
      )}

      <div
        className={cn(
          'flex flex-col gap-2 rounded-lg border p-3 transition-colors',
          isFocused
            ? 'border-primary bg-muted/50'
            : 'border-border bg-background',
          className
        )}
      >
        {/* Textarea */}
        <textarea
          ref={textareaRef}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          onFocus={() => setIsFocused(true)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          className={cn(
            'w-full resize-none bg-transparent',
            'text-sm placeholder:text-muted-foreground',
            'focus:outline-none',
            'max-h-[200px] min-h-[60px]'
          )}
          disabled={isSubmitting}
        />

        {/* Footer - Shows when focused or has content */}
        {(isFocused || content.length > 0) && (
          <div className="flex items-center justify-between gap-2 border-border border-t pt-2">
            {/* Character count */}
            <div className="flex-1 text-muted-foreground text-xs">
              {showCharCount && (
                <span
                  className={cn(isOverLimit && 'font-medium text-destructive')}
                >
                  {remainingChars} characters remaining
                </span>
              )}
            </div>

            {/* Actions */}
            <div className="flex items-center gap-2">
              {/* Cancel button - only show for replies */}
              {parentCommentId && onCancel && (
                <button
                  type="button"
                  onClick={handleCancel}
                  disabled={isSubmitting}
                  className={cn(
                    'rounded-md px-3 py-1.5 text-sm',
                    'text-muted-foreground hover:text-foreground',
                    'transition-colors hover:bg-muted',
                    'disabled:cursor-not-allowed disabled:opacity-50'
                  )}
                >
                  <X size={16} />
                </button>
              )}

              {/* Submit button */}
              <button
                type="button"
                onClick={handleSubmit}
                disabled={!content.trim() || isSubmitting || isOverLimit}
                className={cn(
                  'flex items-center gap-2 rounded-md px-4 py-1.5',
                  'bg-primary text-primary-foreground',
                  'transition-colors hover:bg-primary/90',
                  'font-medium text-sm',
                  'disabled:cursor-not-allowed disabled:opacity-50'
                )}
              >
                {isSubmitting ? (
                  <>
                    <span>Posting...</span>
                  </>
                ) : (
                  <>
                    <Send size={16} />
                    <span>Post</span>
                  </>
                )}
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
