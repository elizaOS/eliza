'use client';

import type { FeedTagData } from '@feed/shared';
import { cn } from '@feed/shared';
import { Heart, MessageCircle, Share2 } from 'lucide-react';
import Link from 'next/link';
import { PanelViewMoreLink } from './PanelViewMoreLink';

interface FeedPanelProps {
  data: FeedTagData;
}

/** Generate a consistent color based on a string (author name) */
function getAvatarColor(name: string): string {
  const colors = [
    'bg-red-500',
    'bg-orange-500',
    'bg-amber-500',
    'bg-yellow-500',
    'bg-lime-500',
    'bg-green-500',
    'bg-emerald-500',
    'bg-teal-500',
    'bg-cyan-500',
    'bg-sky-500',
    'bg-blue-500',
    'bg-indigo-500',
    'bg-violet-500',
    'bg-purple-500',
    'bg-fuchsia-500',
    'bg-pink-500',
    'bg-rose-500',
  ];
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length] ?? 'bg-primary';
}

/** Get initial(s) from author name */
function getInitials(name: string): string {
  const parts = name.split(/[\s_-]+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0]?.[0] ?? ''}${parts[1]?.[0] ?? ''}`.toUpperCase();
  }
  return (name.slice(0, 2) || '??').toUpperCase();
}

export function FeedPanel({ data }: FeedPanelProps) {
  const { posts, count, hasMore } = data;

  if (!posts || posts.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-4">
        <p className="text-muted-foreground text-sm">No posts in feed</p>
      </div>
    );
  }

  return (
    <div className="space-y-3 p-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-sm">Feed Posts</h3>
        <span className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground text-xs">
          {count} {count === 1 ? 'post' : 'posts'}
        </span>
      </div>

      {/* Posts List */}
      <div className="space-y-2">
        {posts.map((post) => (
          <Link
            key={post.id}
            href={`/post/${post.id}`}
            className="group block rounded-lg border border-border bg-card p-3 transition-all hover:border-primary/30 hover:bg-muted/50"
          >
            {/* Author Row */}
            <div className="flex items-center gap-2.5">
              {/* Avatar */}
              {post.authorProfileImageUrl ? (
                <img
                  src={post.authorProfileImageUrl}
                  alt={post.authorName}
                  className="h-8 w-8 shrink-0 rounded-full object-cover"
                />
              ) : (
                <div
                  className={cn(
                    'flex h-8 w-8 shrink-0 items-center justify-center rounded-full font-medium text-white text-xs',
                    getAvatarColor(post.authorName)
                  )}
                >
                  {getInitials(post.authorName)}
                </div>
              )}

              {/* Author Info */}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate font-medium text-sm">
                    @{post.authorName}
                  </span>
                  <span className="shrink-0 text-muted-foreground text-xs">
                    · {post.timeAgo}
                  </span>
                </div>
              </div>
            </div>

            {/* Content */}
            <p className="mt-2 line-clamp-3 text-foreground/90 text-sm leading-relaxed">
              {post.content}
            </p>

            {/* Engagement Stats */}
            <div className="mt-3 flex items-center gap-4 text-muted-foreground text-xs">
              <span className="flex items-center gap-1.5 transition-colors group-hover:text-red-500">
                <Heart className="h-3.5 w-3.5" />
                <span>{post.likeCount}</span>
              </span>
              <span className="flex items-center gap-1.5 transition-colors group-hover:text-blue-500">
                <MessageCircle className="h-3.5 w-3.5" />
                <span>{post.commentCount}</span>
              </span>
              <span className="flex items-center gap-1.5 transition-colors group-hover:text-green-500">
                <Share2 className="h-3.5 w-3.5" />
                <span>{post.shareCount}</span>
              </span>
            </div>
          </Link>
        ))}
      </div>

      {/* View More Link */}
      {hasMore && (
        <PanelViewMoreLink href="/feed">View more on feed</PanelViewMoreLink>
      )}
    </div>
  );
}
