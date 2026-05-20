'use client';

import { cn, logger } from '@feed/shared';
import { Minus, Plus, UserMinus, UserPlus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Skeleton } from '@/components/shared/Skeleton';
import { useAuth } from '@/hooks/useAuth';
import { useSocialTracking } from '@/hooks/usePostHog';
import { getAuthToken } from '@/lib/auth';
import { apiUrl } from '@/utils/api-url';

/**
 * Follow button component for following/unfollowing users.
 *
 * Displays a follow/unfollow button with loading states and automatic
 * status checking. Hides for own profile. Tracks follow actions with
 * PostHog analytics. Supports both button and icon-only variants.
 *
 * @param props - FollowButton component props
 * @returns Follow button element or null if own profile
 *
 * @example
 * ```tsx
 * <FollowButton
 *   userId="user-123"
 *   initialFollowing={false}
 *   onFollowChange={(isFollowing) => console.log(isFollowing)}
 * />
 * ```
 */
interface FollowButtonProps {
  userId: string;
  initialFollowing?: boolean;
  size?: 'sm' | 'md' | 'lg';
  variant?: 'button' | 'icon' | 'circle';
  className?: string;
  onFollowChange?: (isFollowing: boolean) => void;
  onFollowerCountChange?: (delta: number) => void; // +1 for follow, -1 for unfollow
}

export function FollowButton({
  userId,
  initialFollowing,
  size = 'md',
  variant = 'button',
  className,
  onFollowChange,
  onFollowerCountChange,
}: FollowButtonProps) {
  const { authenticated, user } = useAuth();
  const [isFollowing, setIsFollowing] = useState(initialFollowing ?? false);
  const [isLoading, setIsLoading] = useState(false);
  const [isChecking, setIsChecking] = useState(initialFollowing === undefined);
  const { trackFollow } = useSocialTracking();

  // Check follow status on mount
  useEffect(() => {
    if (initialFollowing !== undefined) {
      setIsFollowing(initialFollowing);
      setIsChecking(false);
      return;
    }

    // Check if viewing own profile (userId could be username or user ID)
    const isOwnProfile =
      user &&
      (user.id === userId ||
        user.username === userId ||
        (user.username &&
          user.username.startsWith('@') &&
          user.username.slice(1) === userId));

    if (!authenticated || !user || isOwnProfile) {
      setIsChecking(false);
      return;
    }

    const checkFollowStatus = async () => {
      if (!userId) {
        setIsChecking(false);
        return;
      }

      const token = getAuthToken();
      if (!token) {
        setIsChecking(false);
        return;
      }

      // Encode userId/username to handle special characters
      const encodedIdentifier = encodeURIComponent(userId);
      const response = await fetch(
        apiUrl(`/api/users/${encodedIdentifier}/follow`),
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      );

      if (response.ok) {
        const data = await response.json();
        setIsFollowing(data.isFollowing || false);
      } else {
        // If check fails, assume not following (don't show error)
        setIsFollowing(false);
      }
      setIsChecking(false);
    };

    checkFollowStatus();
  }, [authenticated, initialFollowing, user, userId]);

  const handleFollow = async () => {
    if (!authenticated || !user) {
      toast.error('Please sign in to follow users');
      return;
    }

    // Check if viewing own profile (userId could be username or user ID)
    const isOwnProfile =
      user.id === userId ||
      user.username === userId ||
      (user.username &&
        user.username.startsWith('@') &&
        user.username.slice(1) === userId);

    if (isOwnProfile) {
      // Don't show error, just return silently (button shouldn't be visible anyway)
      return;
    }

    if (!userId) {
      logger.error(
        'No userId/username provided to FollowButton',
        {},
        'FollowButton'
      );
      return;
    }

    setIsLoading(true);
    const token = getAuthToken();
    if (!token) {
      toast.error('Authentication required');
      setIsLoading(false);
      return;
    }

    // Optimistic update
    const newFollowingState = !isFollowing;
    const delta = newFollowingState ? 1 : -1;

    setIsFollowing(newFollowingState);
    onFollowChange?.(newFollowingState);
    onFollowerCountChange?.(delta); // Update follower count immediately

    // Encode userId/username to handle special characters
    const encodedIdentifier = encodeURIComponent(userId);
    const method = newFollowingState ? 'POST' : 'DELETE';
    const response = await fetch(
      apiUrl(`/api/users/${encodedIdentifier}/follow`),
      {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }
    );

    if (response.ok) {
      // Success! State was already updated optimistically above
      // Just track the action, don't update state again (causes race condition)
      trackFollow(userId, newFollowingState);
      // Follower count is already updated via onFollowerCountChange callback
    } else {
      // Revert optimistic update on error
      setIsFollowing(!newFollowingState);
      onFollowChange?.(!newFollowingState);
      onFollowerCountChange?.(-delta); // Revert follower count

      // Try to get error message, but don't show generic errors for 404s
      const errorData = await response.json();
      if (response.status === 404) {
        // If profile not found, silently fail or show a more helpful message
        logger.warn(
          'Profile not found for follow:',
          { userId },
          'FollowButton'
        );
        toast.error('Unable to follow this profile');
      } else {
        // Extract error message properly (handle both string and object formats)
        const errorMessage =
          typeof errorData?.error === 'string'
            ? errorData.error
            : errorData?.error?.message || 'Failed to update follow status';
        toast.error(errorMessage);
      }
    }
    setIsLoading(false);
  };

  // Don't show button if checking or if user is viewing their own profile
  const isOwnProfile =
    user &&
    (user.id === userId ||
      user.username === userId ||
      (user.username &&
        user.username.startsWith('@') &&
        user.username.slice(1) === userId));

  // Don't show for own profile or when not authenticated
  if (isOwnProfile || !authenticated) {
    return null;
  }

  const sizeClasses = {
    sm: 'text-xs px-2 py-1',
    md: 'text-sm px-3 py-1.5',
    lg: 'text-base px-4 py-2',
  };

  const iconSizes = {
    sm: 'w-4 h-4', // Increased from w-3 h-3
    md: 'w-5 h-5', // Increased from w-4 h-4
    lg: 'w-6 h-6', // Increased from w-5 h-5
  };

  const iconButtonSizes = {
    sm: 'p-1.5', // Consistent padding for touch targets
    md: 'p-2',
    lg: 'p-2.5',
  };

  if (variant === 'circle') {
    if (isChecking) return null;

    return (
      <button
        onClick={handleFollow}
        disabled={isLoading}
        className={cn(
          'flex items-center justify-center rounded-full border-2 border-background transition-colors',
          isFollowing
            ? 'bg-red-500 hover:bg-red-600'
            : 'bg-primary hover:bg-primary/80',
          isLoading && 'cursor-not-allowed opacity-50',
          'h-5 w-5',
          className
        )}
        aria-label={isFollowing ? 'Unfollow' : 'Follow'}
      >
        {isFollowing ? (
          <Minus className="h-3 w-3 text-white" />
        ) : (
          <Plus className="h-3 w-3 text-white" />
        )}
      </button>
    );
  }

  if (variant === 'icon') {
    // Show subtle skeleton during loading to prevent layout shift
    if (isChecking) {
      return (
        <div
          className={cn(
            'flex items-center justify-center rounded transition-colors',
            iconButtonSizes[size],
            className
          )}
          aria-label="Loading follow status"
        >
          <Skeleton
            className={cn(iconSizes[size], 'rounded-full opacity-40')}
          />
        </div>
      );
    }

    return (
      <button
        onClick={handleFollow}
        disabled={isLoading}
        className={cn(
          'rounded transition-colors',
          iconButtonSizes[size],
          isFollowing
            ? 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
            : 'text-primary hover:bg-primary/10 hover:text-primary/80',
          isLoading && 'cursor-not-allowed opacity-50',
          className
        )}
        aria-label={isFollowing ? 'Unfollow' : 'Follow'}
      >
        {isLoading ? (
          <Skeleton className={cn(iconSizes[size], 'rounded')} />
        ) : isFollowing ? (
          <UserMinus className={iconSizes[size]} />
        ) : (
          <UserPlus className={iconSizes[size]} />
        )}
      </button>
    );
  }

  // For button variant, show subtle skeleton during checking
  if (isChecking) {
    return (
      <div
        className={cn(
          'flex items-center justify-center rounded-full border border-muted',
          sizeClasses[size],
          className
        )}
        aria-label="Loading follow status"
      >
        <Skeleton className="h-4 w-12 rounded opacity-40" />
      </div>
    );
  }

  // Old-school style button
  return (
    <button
      onClick={handleFollow}
      disabled={isLoading}
      className={cn(
        'group relative flex items-center justify-center gap-1.5 rounded-full font-bold transition-all duration-200',
        'border',
        isFollowing
          ? 'border-border bg-background text-foreground hover:border-red-500/50 hover:bg-red-500/10 hover:text-red-500'
          : 'border-[#0066FF] bg-[#0066FF] text-primary-foreground hover:bg-[#0052CC]',
        sizeClasses[size],
        isLoading && 'cursor-not-allowed opacity-50',
        className
      )}
    >
      {isLoading ? (
        <>
          <span>...</span>
        </>
      ) : isFollowing ? (
        <>
          <span className="group-hover:hidden">Following</span>
          <span className="hidden group-hover:inline">Unfollow</span>
        </>
      ) : (
        <span>Follow</span>
      )}
    </button>
  );
}
