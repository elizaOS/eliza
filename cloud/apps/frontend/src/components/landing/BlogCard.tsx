"use client";

import Image from "@elizaos/cloud-ui/runtime/image";
import { Link } from "react-router-dom";
import type { BlogPostMeta } from "@/lib/blog";

interface BlogCardProps {
  post: BlogPostMeta;
}

const categoryColors: Record<string, string> = {
  announcements: "bg-orange-500/20 text-orange-400",
  tutorials: "bg-blue-500/20 text-blue-400",
  news: "bg-green-500/20 text-green-400",
  uncategorized: "bg-neutral-500/20 text-neutral-400",
};

export default function BlogCard({ post }: BlogCardProps) {
  const formattedDate = new Date(post.date).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const categoryClass = categoryColors[post.category] || categoryColors.uncategorized;

  return (
    <Link to={`/blog/${post.slug}`} className="group block">
      <article className="h-full overflow-hidden rounded-xl border border-white/10 bg-neutral-950 hover:bg-neutral-900 transition-all duration-300 hover:ring-2 hover:ring-orange-500/40">
        {post.image && (
          <div className="relative aspect-[1200/630] w-full overflow-hidden">
            <Image
              src={post.image}
              alt={post.title}
              fill
              sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw"
              className="object-cover"
            />
          </div>
        )}
        {!post.image && (
          <div className="flex aspect-[1200/630] w-full items-center justify-center bg-gradient-to-br from-orange-500/20 to-orange-600/10">
            <span className="text-4xl text-orange-500/50">✦</span>
          </div>
        )}

        <div className="p-4 sm:p-5">
          <div className="mb-3 flex items-center gap-2">
            <span
              className={`rounded-full px-2.5 py-0.5 text-xs font-medium capitalize ${categoryClass}`}
            >
              {post.category}
            </span>
            <span className="text-xs text-neutral-300">{formattedDate}</span>
          </div>

          <h3 className="mb-2 text-lg font-semibold text-white transition-colors group-hover:text-orange-400">
            {post.title}
          </h3>

          <p className="line-clamp-2 text-sm text-neutral-400 transition-colors group-hover:text-neutral-200">
            {post.description}
          </p>
        </div>
      </article>
    </Link>
  );
}
