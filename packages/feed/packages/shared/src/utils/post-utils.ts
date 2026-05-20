export function isPureRepost(post: {
  originalPostId?: string | null;
  content: string;
}): post is { originalPostId: string; content: string } {
  return (
    typeof post.originalPostId === 'string' &&
    post.originalPostId.trim().length > 0 &&
    post.content.trim().length === 0
  );
}
