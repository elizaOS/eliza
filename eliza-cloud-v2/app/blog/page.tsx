import { Suspense } from "react";
import { BlogPage } from "@/components/landing/blog-page";
import Blog from "@/components/landing/Blog";
import { getAllPosts, getPublicPosts, getPublicCategories } from "@/lib/blog";

export const metadata = {
  title: "Cloud Blog",
  description: "News, tutorials, and updates from the Eliza team",
};

function BlogContent() {
  const allPosts = getAllPosts();
  const publicPosts = getPublicPosts();
  const categories = getPublicCategories();

  return (
    <Blog
      allPosts={allPosts}
      publicPosts={publicPosts}
      categories={categories}
    />
  );
}

export default function BlogListingPage() {
  return (
    <BlogPage>
      <Suspense
        fallback={
          <div className="flex-1 px-4 pt-24 pb-12 text-center text-white/50">
            Loading...
          </div>
        }
      >
        <BlogContent />
      </Suspense>
    </BlogPage>
  );
}
