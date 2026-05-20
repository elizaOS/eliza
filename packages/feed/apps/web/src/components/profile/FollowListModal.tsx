'use client';

import { cn, getProfileUrl } from '@feed/shared';
import { Loader2, Users, X } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Avatar } from '@/components/shared/Avatar';
import { VerifiedBadge } from '@/components/shared/VerifiedBadge';
import { useAuth } from '@/hooks/useAuth';
import { apiUrl } from '@/utils/api-url';

/**
 * FollowListModal component for displaying followers or following lists.
 *
 * Shows a scrollable list of users with their avatars, names, and follow/unfollow
 * buttons. Displays up to 100 users per list.
 *
 * @param props - FollowListModal component props
 * @returns Follow list modal element or null if not open
 *
 * @example
 * ```tsx
 * <FollowListModal
 *   isOpen={showModal}
 *   onClose={() => setShowModal(false)}
 *   userId="user-123"
 *   type="followers"
 *   title="Followers"
 * />
 * ```
 */

interface FollowUser {
  id: string;
  displayName: string;
  username: string | null;
  profileImageUrl: string | null;
  bio: string | null;
  isActor: boolean;
  followedAt: string;
  tier?: string | null;
  isMutualFollow?: boolean;
}

interface FollowListModalProps {
  isOpen: boolean;
  onClose: () => void;
  userId: string;
  type: 'followers' | 'following';
  title?: string;
}

export function FollowListModal({
  isOpen,
  onClose,
  userId,
  type,
  title,
}: FollowListModalProps) {
  const { authenticated, user, getAccessToken } = useAuth();
  const [users, setUsers] = useState<FollowUser[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [followingStatus, setFollowingStatus] = useState<
    Record<string, boolean>
  >({});
  const [loadingFollow, setLoadingFollow] = useState<Record<string, boolean>>(
    {}
  );

  // AbortController ref for cancelling pending requests
  const abortControllerRef = useRef<AbortController | null>(null);

  const displayTitle =
    title || (type === 'followers' ? 'Followers' : 'Following');

  // Fetch the list when modal opens
  const fetchList = useCallback(async () => {
    if (!isOpen || !userId) return;

    // Cancel any pending request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    // Create new AbortController for this request
    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    setIsLoading(true);
    setError(null);

    try {
      const token = await getAccessToken();
      const headers: HeadersInit = {
        'Content-Type': 'application/json',
      };
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }

      const response = await fetch(
        apiUrl(
          `/api/users/${encodeURIComponent(userId)}/${type}?page=1&limit=100`
        ),
        { headers, signal: abortController.signal }
      );

      if (!response.ok) {
        setError('Failed to load list');
        setIsLoading(false);
        return;
      }

      const data = await response.json();
      const list = type === 'followers' ? data.followers : data.following;
      setUsers(list || []);

      // Initialize following status for each user
      // isFollowedByCurrentUser indicates if the current user follows each person in the list
      if (authenticated && user) {
        const statusMap: Record<string, boolean> = {};
        for (const u of list || []) {
          if (type === 'following' && userId === user.id) {
            // Viewing own following list - current user follows everyone in this list
            statusMap[u.id] = true;
          } else {
            // Viewing followers or someone else's following list
            // isMutualFollow indicates if the current user follows this person
            statusMap[u.id] = u.isMutualFollow || false;
          }
        }
        setFollowingStatus(statusMap);
      }

      setIsLoading(false);
    } catch (err) {
      // Ignore abort errors - they're expected when cancelling requests
      if (err instanceof Error && err.name === 'AbortError') {
        return;
      }
      setError('Network error. Please try again.');
      setIsLoading(false);
    }
  }, [isOpen, userId, type, authenticated, user, getAccessToken]);

  // Cleanup abort controller on unmount
  useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, []);

  useEffect(() => {
    fetchList();
  }, [fetchList]);

  // Handle body scroll lock
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [isOpen]);

  // Handle escape key
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    if (isOpen) {
      window.addEventListener('keydown', handleEscape);
    }
    return () => {
      window.removeEventListener('keydown', handleEscape);
    };
  }, [isOpen, onClose]);

  const handleFollow = async (targetUserId: string) => {
    if (!authenticated || !user) {
      toast.error('Please sign in to follow users');
      return;
    }

    if (targetUserId === user.id) {
      return;
    }

    setLoadingFollow((prev) => ({ ...prev, [targetUserId]: true }));

    const token = await getAccessToken();
    if (!token) {
      toast.error('Authentication required');
      setLoadingFollow((prev) => ({ ...prev, [targetUserId]: false }));
      return;
    }

    const isCurrentlyFollowing = followingStatus[targetUserId] ?? false;
    const method = isCurrentlyFollowing ? 'DELETE' : 'POST';

    // Optimistic update
    setFollowingStatus((prev) => ({
      ...prev,
      [targetUserId]: !isCurrentlyFollowing,
    }));

    try {
      const response = await fetch(
        apiUrl(`/api/users/${encodeURIComponent(targetUserId)}/follow`),
        {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      );

      if (!response.ok) {
        // Revert optimistic update
        setFollowingStatus((prev) => ({
          ...prev,
          [targetUserId]: isCurrentlyFollowing,
        }));
        toast.error('Failed to update follow status');
      } else {
        // Dispatch event to update profile stats
        window.dispatchEvent(
          new CustomEvent('profile-updated', {
            detail: { type: isCurrentlyFollowing ? 'unfollow' : 'follow' },
          })
        );
      }
    } catch {
      // Revert optimistic update on network error
      setFollowingStatus((prev) => ({
        ...prev,
        [targetUserId]: isCurrentlyFollowing,
      }));
      toast.error('Network error. Please try again.');
    }

    setLoadingFollow((prev) => ({ ...prev, [targetUserId]: false }));
  };

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-[110] flex items-center justify-center bg-black/50 p-0 backdrop-blur-sm md:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="follow-list-modal-title"
      onClick={onClose}
    >
      {/* Modal */}
      <div
        className="relative flex h-full w-full flex-col bg-background md:h-auto md:max-h-[80vh] md:w-auto md:min-w-[480px] md:max-w-md md:rounded-2xl md:border md:border-border md:shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex shrink-0 items-start justify-between border-border border-b px-6 py-4">
          <div className="flex items-center gap-2">
            <Users className="h-5 w-5 text-muted-foreground" />
            <h2
              id="follow-list-modal-title"
              className="font-bold text-foreground text-xl"
            >
              {displayTitle}
            </h2>
            {!isLoading && (
              <span className="text-muted-foreground text-sm">
                ({users.length})
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            className="rounded-full p-2 transition-colors hover:bg-muted/50"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Content */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : error ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <p className="text-muted-foreground">{error}</p>
              <button
                onClick={fetchList}
                className="mt-4 rounded-lg bg-primary px-4 py-2 text-primary-foreground transition-colors hover:bg-primary/90"
              >
                Try again
              </button>
            </div>
          ) : users.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <Users className="mb-4 h-12 w-12 text-muted-foreground opacity-50" />
              <p className="text-muted-foreground">
                {type === 'followers'
                  ? 'No followers yet'
                  : 'Not following anyone yet'}
              </p>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {users.map((followUser) => {
                const isOwnProfile = user?.id === followUser.id;
                const isFollowing = followingStatus[followUser.id] || false;
                const isLoadingThis = loadingFollow[followUser.id] || false;
                const profileUrl = getProfileUrl(
                  followUser.id,
                  followUser.username
                );

                return (
                  <div
                    key={followUser.id}
                    className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/30"
                  >
                    {/* Avatar */}
                    <Link href={profileUrl} onClick={onClose}>
                      <Avatar
                        id={followUser.id}
                        name={followUser.displayName}
                        type={followUser.isActor ? 'actor' : 'user'}
                        src={followUser.profileImageUrl || undefined}
                        size="md"
                        className="flex-shrink-0"
                      />
                    </Link>

                    {/* User Info */}
                    <div className="min-w-0 flex-1">
                      <Link
                        href={profileUrl}
                        onClick={onClose}
                        className="group flex items-center gap-1"
                      >
                        <span className="truncate font-semibold text-foreground group-hover:underline">
                          {followUser.displayName}
                        </span>
                        {followUser.isActor && <VerifiedBadge size="sm" />}
                      </Link>
                      {followUser.username && (
                        <p className="truncate text-muted-foreground text-sm">
                          @{followUser.username}
                        </p>
                      )}
                    </div>

                    {/* Follow Button */}
                    {authenticated && !isOwnProfile && (
                      <button
                        onClick={() => handleFollow(followUser.id)}
                        disabled={isLoadingThis}
                        className={cn(
                          'group relative flex shrink-0 items-center justify-center gap-1.5 rounded-full border px-3 py-1.5 font-bold text-sm transition-all duration-200',
                          isFollowing
                            ? 'border-border bg-background text-foreground hover:border-red-500/50 hover:bg-red-500/10 hover:text-red-500'
                            : 'border-[#0066FF] bg-[#0066FF] text-primary-foreground hover:bg-[#0052CC]',
                          isLoadingThis && 'cursor-not-allowed opacity-50'
                        )}
                      >
                        {isLoadingThis ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : isFollowing ? (
                          <>
                            <span className="group-hover:hidden">
                              Following
                            </span>
                            <span className="hidden group-hover:inline">
                              Unfollow
                            </span>
                          </>
                        ) : (
                          <span>Follow</span>
                        )}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
