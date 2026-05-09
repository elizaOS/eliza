"use client";

import { useSearchParams } from "react-router-dom";
import type { BlogPostMeta } from "@/lib/blog";
import BlogCard from "./BlogCard";
import CategoryFilter from "./CategoryFilter";

interface BlogProps {
  allPosts: BlogPostMeta[];
  publicPosts: BlogPostMeta[];
  categories: string[];
}

export default function Blog({ allPosts, publicPosts, categories }: BlogProps) {
  const [searchParams] = useSearchParams();
  const activeCategory = searchParams.get("category");

  // Only show demo posts when explicitly filtered by ?category=demo
  // Otherwise show public posts (non-demo) filtered by category if selected
  const filteredPosts =
    activeCategory === "demo"
      ? allPosts.filter((post) => post.category === "demo")
      : activeCategory
        ? publicPosts.filter((post) => post.category === activeCategory)
        : publicPosts;

  return (
    <div className="flex-1 px-4 pt-24 pb-12 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-6xl">
        <div className="mb-8 text-center">
          <h1 className="text-4xl font-bold text-white sm:text-6xl">Cloud Blog</h1>
        </div>

        <div className="mb-8 sm:flex sm:justify-center">
          <CategoryFilter categories={categories} />
        </div>

        {filteredPosts.length === 0 ? (
          <div className="py-12 text-center">
            <p className="text-neutral-400">No posts found.</p>
          </div>
        ) : (
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {filteredPosts.map((post) => (
              <BlogCard key={post.slug} post={post} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
