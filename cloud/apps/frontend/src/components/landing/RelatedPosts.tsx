"use client";

import type { BlogPostMeta } from "@/lib/blog";
import BlogCard from "./BlogCard";

interface RelatedPostsProps {
  posts: BlogPostMeta[];
}

export default function RelatedPosts({ posts }: RelatedPostsProps) {
  if (posts.length === 0) {
    return null;
  }

  return (
    <section className="border-t mx-auto container border-white/10 px-0 sm:px-4 lg:px-6 py-6 sm:py-20">
      <div className="mb-8 sm:mb-12 flex flex-col gap-1 sm:gap-4 sm:flex-row sm:items-end sm:justify-between">
        <h2 className="text-4xl font-bold text-white sm:text-5xl">Related posts</h2>
        <p className="text-neutral-300 text-lg sm:text-xl">Explore more from elizaOS</p>
      </div>

      <div className="grid gap-6 sm:grid-cols-2 xl:grid-cols-4">
        {posts.slice(0, 4).map((post) => (
          <BlogCard key={post.slug} post={post} />
        ))}
      </div>
    </section>
  );
}
