"use client";

import { Image } from "@elizaos/cloud-ui";
import { ArrowLeft } from "lucide-react";
import { Link } from "react-router-dom";

interface BlogPostProps {
  title: string;
  date: string;
  author: string;
  category: string;
  image?: string;
  children: React.ReactNode;
}

const categoryColors: Record<string, string> = {
  announcements: "bg-orange-500/20 text-orange-400",
  tutorials: "bg-blue-500/20 text-blue-400",
  news: "bg-green-500/20 text-green-400",
  uncategorized: "bg-neutral-500/20 text-neutral-400",
};

export default function BlogPost({
  title,
  date,
  author,
  category,
  image,
  children,
}: BlogPostProps) {
  const formattedDate = new Date(date).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const categoryClass = categoryColors[category] || categoryColors.uncategorized;

  return (
    <div className="flex flex-col">
      <div className="flex-1 flex">
        <div className="bg-gradient-to-r from-black/0 to-black/75 flex-1"></div>
        <div className="w-full max-w-3xl h-20 bg-black/75 mx-auto"></div>
        <div className="bg-gradient-to-l from-black/0 to-black/75 flex-1"></div>
      </div>
      <div className="flex-1 flex">
        <div className="bg-gradient-to-r from-black/0 to-black/75 flex-1"></div>
        <div className="w-full max-w-3xl bg-black/75 px-4 sm:px-6 lg:px-8">
          <div className="sticky top-20 z-10 mb-8">
            <Link
              to="/blog"
              className="inline-flex items-center gap-2 rounded-full bg-white/10 px-4 py-2 text-sm text-neutral-200 backdrop-blur-sm transition-colors hover:bg-orange-500/40 hover:text-white"
            >
              <ArrowLeft className="h-4 w-4" />
              Back to Blog
            </Link>
          </div>

          <article>
            {image && (
              <div className="relative mb-8 aspect-[1200/630] w-full overflow-hidden rounded-xl">
                <Image
                  src={image}
                  alt={title}
                  width={1200}
                  height={630}
                  className="object-cover"
                  priority
                />
              </div>
            )}

            <header className="mb-8">
              <div className="mb-4 flex items-center gap-3">
                <span
                  className={`rounded-full px-3 py-1 text-xs font-medium capitalize ${categoryClass}`}
                >
                  {category}
                </span>
                <span className="text-sm text-neutral-300">{formattedDate}</span>
              </div>

              <h1 className="text-3xl font-bold text-white sm:text-4xl lg:text-5xl">{title}</h1>
            </header>

            <div className="prose prose-invert prose-orange max-w-none lg:prose-lg xl:prose-xl prose-headings:text-white prose-headings:font-bold prose-headings:mt-12 prose-headings:mb-4 prose-h2:mt-16 prose-h3:mt-10 prose-p:text-neutral-300 prose-a:text-orange-400 prose-strong:text-white prose-code:text-orange-300 prose-pre:bg-white/5 prose-pre:border prose-pre:border-white/10 prose-pre:rounded-none prose-pre:scrollbar-thin prose-pre:scrollbar-thumb-brand-orange prose-pre:scrollbar-track-black prose-img:rounded-xl [&_table]:block [&_table]:overflow-x-auto prose-th:border prose-th:border-white/10 prose-th:bg-white/5 prose-th:px-4 prose-th:py-2 prose-td:border prose-td:border-white/10 prose-td:px-4 prose-td:py-2 prose-tr:border-b prose-tr:border-white/10 prose-li:marker:text-orange-400 prose-ol:marker:text-orange-400 prose-li:my-1 prose-ul:my-2 prose-ol:my-2 prose-hr:hidden prose-blockquote:border-l-orange-500 prose-blockquote:bg-orange-500/10 prose-blockquote:rounded-r-lg prose-blockquote:py-1 [&>h1:first-child]:hidden [&_details]:my-2 [&_details[open]]:mb-6 [&_details_summary]:cursor-pointer [&_details>*:nth-child(2)]:mt-2 [&_details_ol]:mt-1 [&_details_p]:mb-1">
              {children}
            </div>
          </article>
        </div>
        <div className="bg-gradient-to-l from-black/0 to-black/75 flex-1"></div>
      </div>
      <div className="flex-1 flex">
        <div className="bg-gradient-to-r from-black/0 to-black/75 flex-1"></div>
        <div className="w-full max-w-3xl h-20 bg-black/75 mx-auto"></div>
        <div className="bg-gradient-to-l from-black/0 to-black/75 flex-1"></div>
      </div>
    </div>
  );
}
