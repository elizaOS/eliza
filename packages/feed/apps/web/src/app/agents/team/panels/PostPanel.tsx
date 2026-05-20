'use client';

import type { PostTagData } from '@babylon/shared';
import { cn } from '@babylon/shared';
import { MessageCircle, Repeat2 } from 'lucide-react';
import Link from 'next/link';
import { PanelViewMoreLink } from './PanelViewMoreLink';

interface PostPanelProps {
  data: PostTagData;
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

/** Format ISO date string to relative or absolute */
function formatDate(dateString: string): string {
  const date = new Date(dateString);
  const now = Date.now();
  const diffMs = now - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

export function PostPanel({ data }: PostPanelProps) {
  const { post, commentCount, shareCount } = data;

  return (
    <div className="space-y-4 p-4">
      {/* Post */}
      <div className="rounded-lg border border-border bg-card p-4">
        {/* Author Row */}
        <div className="flex items-center gap-3">
          {/* Avatar */}
          <Link
            href={`/profile/${post.authorId}`}
            className="shrink-0 transition-opacity hover:opacity-80"
          >
            {post.authorProfileImageUrl ? (
              <img
                src={post.authorProfileImageUrl}
                alt={post.author}
                className="h-10 w-10 rounded-full object-cover"
              />
            ) : (
              <div
                className={cn(
                  'flex h-10 w-10 items-center justify-center rounded-full font-medium text-sm text-white',
                  getAvatarColor(post.author)
                )}
              >
                {getInitials(post.author)}
              </div>
            )}
          </Link>

          {/* Author Info */}
          <div className="min-w-0 flex-1">
            <Link
              href={`/profile/${post.authorId}`}
              className="block truncate font-medium text-sm transition-colors hover:text-primary"
            >
              @{post.author}
            </Link>
            <span className="text-muted-foreground text-xs">
              {formatDate(post.createdAt)}
            </span>
          </div>
        </div>

        {/* Content */}
        <p className="mt-3 whitespace-pre-wrap text-foreground/90 text-sm leading-relaxed">
          {post.content}
        </p>

        {/* Engagement Stats */}
        <div className="mt-4 flex items-center gap-4 text-muted-foreground text-xs">
          <span className="flex items-center gap-1.5">
            <MessageCircle className="h-4 w-4" />
            <span>{commentCount}</span>
          </span>
          {shareCount !== undefined && (
            <span className="flex items-center gap-1.5">
              <Repeat2 className="h-4 w-4" />
              <span>{shareCount}</span>
            </span>
          )}
        </div>
      </div>

      {/* Link to full post */}
      <PanelViewMoreLink href={`/post/${post.id}`}>
        View full post
      </PanelViewMoreLink>
    </div>
  );
}
