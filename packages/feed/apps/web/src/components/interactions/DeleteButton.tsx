'use client';

import { cn, logger } from '@babylon/shared';
import { Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { apiUrl } from '@/utils/api-url';

/**
 * Delete button component for post deletion.
 *
 * Displays a delete button that only shows for the post author.
 * Includes confirmation modal before deletion. Refreshes the page
 * after successful deletion to remove the post from view.
 *
 * @param props - DeleteButton component props
 * @returns Delete button element or null if user is not the author
 *
 * @example
 * ```tsx
 * <DeleteButton
 *   postId="post-123"
 *   postAuthorId="user-456"
 *   onDeleted={() => console.log('Deleted')}
 * />
 * ```
 */
interface DeleteButtonProps {
  postId: string;
  postAuthorId: string;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
  onDeleted?: () => void;
}

const sizeClasses = {
  sm: 'text-xs gap-1',
  md: 'h-10 px-3 text-sm gap-1.5',
  lg: 'h-12 px-4 text-base gap-2',
};

const iconSizes = {
  sm: 16,
  md: 18,
  lg: 20,
};

export function DeleteButton({
  postId,
  postAuthorId,
  size = 'md',
  className,
  onDeleted,
}: DeleteButtonProps) {
  const [showConfirmation, setShowConfirmation] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const { user } = useAuth();

  // Only show delete button if user is the author
  if (!user || user.id !== postAuthorId) {
    return null;
  }

  const handleDelete = async () => {
    setIsDeleting(true);
    const response = await fetch(apiUrl(`/api/posts/${postId}`), {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    const data = await response.json();

    if (!response.ok) {
      setIsDeleting(false);
      setShowConfirmation(false);
      throw new Error(data.error || 'Failed to delete post');
    }

    logger.info(
      'Post deleted successfully',
      { postId, userId: user.id },
      'DeleteButton'
    );

    // Call callback if provided
    if (onDeleted) {
      onDeleted();
    }

    // Refresh the page to remove the post from view
    window.location.reload();
  };

  const handleClick = () => {
    setShowConfirmation(true);
  };

  return (
    <>
      <button
        type="button"
        onClick={handleClick}
        disabled={isDeleting}
        className={cn(
          'flex items-center bg-transparent transition-all duration-200 hover:text-red-500',
          sizeClasses[size],
          isDeleting && 'cursor-not-allowed opacity-50',
          className
        )}
        title="Delete post"
      >
        <Trash2 size={iconSizes[size]} />
      </button>

      {/* Confirmation Modal */}
      {showConfirmation && (
        <div
          className="fixed inset-0 z-[110] flex items-center justify-center bg-black/50"
          onClick={() => setShowConfirmation(false)}
        >
          <div
            className="mx-4 max-w-sm rounded-lg border border-border bg-background p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="mb-2 font-semibold text-lg">Delete Post?</h3>
            <p className="mb-4 text-muted-foreground">
              This post will be permanently deleted. This action cannot be
              undone.
            </p>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setShowConfirmation(false)}
                className="rounded-lg bg-muted px-4 py-2 transition-colors hover:bg-muted/80"
                disabled={isDeleting}
              >
                Cancel
              </button>
              <button
                onClick={handleDelete}
                disabled={isDeleting}
                className="rounded-lg bg-red-500 px-4 py-2 text-primary-foreground transition-colors hover:bg-red-600 disabled:opacity-50"
              >
                {isDeleting ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
