"use client";

export const dynamic = "force-dynamic";

import { ArrowLeft, Newspaper } from "lucide-react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { use, useEffect, useState } from "react";
import { MoreArticlesWidget } from "@/components/articles/MoreArticlesWidget";
import { Response } from "@/components/chat/Response";
import { PageContainer } from "@/components/shared/PageContainer";
import { Skeleton } from "@/components/shared/Skeleton";
import { apiUrl } from "@/utils/api-url";

interface ArticlePageProps {
  params: Promise<{ id: string }>;
}

interface ArticlePost {
  id: string;
  type: string;
  content: string;
  fullContent: string | null;
  articleTitle: string | null;
  byline: string | null;
  biasScore: number | null;
  sentiment: string | null;
  slant: string | null;
  category: string | null;
  imageUrl: string | null;
  authorId: string;
  authorName: string;
  authorUsername: string | null;
  authorProfileImageUrl: string | null;
  timestamp: string;
}

export default function ArticlePage({ params }: ArticlePageProps) {
  const { id: articleId } = use(params);
  const router = useRouter();

  const [article, setArticle] = useState<ArticlePost | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const loadArticle = async () => {
      setIsLoading(true);
      setError(null);

      // Fetch from posts API since articles are posts with type='article'
      const response = await fetch(apiUrl(`/api/posts/${articleId}`));

      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        const errorMsg = result.error?.message || "Failed to load article";
        setError(errorMsg);
        setIsLoading(false);
        return;
      }

      const result = await response.json();
      const articleData = result.data || result;

      // Verify it's actually an article
      if (articleData.type !== "article") {
        // Redirect to regular post page if not an article
        router.replace(`/post/${articleId}`);
        setIsLoading(false);
        return;
      }

      setArticle(articleData);
      setIsLoading(false);
    };

    loadArticle();
  }, [articleId, router]);

  if (isLoading) {
    return (
      <PageContainer noPadding className="flex w-full flex-col">
        <div className="relative flex min-h-dvh flex-1 md:min-h-screen">
          <div className="flex min-w-0 flex-1 flex-col border-border lg:border-r lg:border-l">
            <div className="sticky top-0 z-10 shrink-0 bg-background shadow-sm">
              <div className="px-6 py-4">
                <div className="flex items-center gap-4">
                  <div className="h-9 w-9 rounded-full bg-muted" />
                  <Skeleton className="h-6 w-20" />
                </div>
              </div>
            </div>
            <div className="flex-1 bg-background">
              <div className="w-full lg:mx-auto lg:max-w-[700px]">
                <div className="space-y-4 px-4 py-6">
                  <Skeleton className="h-8 w-3/4" />
                  <Skeleton className="h-64 w-full" />
                  <Skeleton className="h-32 w-full" />
                </div>
              </div>
            </div>
          </div>
          <div className="hidden w-96 flex-none xl:flex" />
        </div>
      </PageContainer>
    );
  }

  if (error || !article) {
    return (
      <PageContainer noPadding className="flex w-full flex-col">
        <div className="relative flex min-h-dvh flex-1 md:min-h-screen">
          <div className="flex min-w-0 flex-1 flex-col border-border lg:border-r lg:border-l">
            <div className="flex flex-1 flex-col items-center justify-center bg-background">
              <div className="text-center">
                <h1 className="mb-2 font-bold text-2xl">Article Not Found</h1>
                <p className="mb-4 text-muted-foreground">
                  {error || "The article you are looking for does not exist."}
                </p>
                <button
                  onClick={() => router.push("/feed")}
                  className="rounded-md bg-primary px-4 py-2 text-primary-foreground transition-colors hover:bg-primary/90"
                >
                  Back to Feed
                </button>
              </div>
            </div>
          </div>
          <div className="hidden w-96 flex-none xl:flex" />
        </div>
      </PageContainer>
    );
  }

  const publishedDate = new Date(article.timestamp);

  // Get article body content for markdown rendering
  const articleBody = article.fullContent || article.content;

  return (
    <PageContainer noPadding className="flex w-full flex-col">
      <div className="relative flex min-h-dvh flex-1 md:min-h-screen">
        {/* Desktop: Article content area */}
        <div className="hidden min-w-0 flex-1 flex-col border-border lg:flex lg:border-r lg:border-l">
          {/* Desktop: Top bar with back button */}
          <div className="sticky top-0 z-10 shrink-0 bg-background shadow-sm">
            <div className="px-6 py-4">
              <div className="flex items-center gap-4">
                <button
                  onClick={() => router.back()}
                  className="rounded-full p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  <ArrowLeft size={20} />
                </button>
                <div className="flex items-center gap-2">
                  <Newspaper className="h-5 w-5 text-[#0066FF]" />
                  <h1 className="font-semibold text-lg">Article</h1>
                </div>
              </div>
            </div>
          </div>

          {/* Article content */}
          <div className="flex-1 bg-background">
            <div className="w-full lg:mx-auto lg:max-w-[700px]">
              <article className="px-6 py-6">
                {/* Article cover image */}
                {article.imageUrl && (
                  <div className="relative mb-6 aspect-video w-full overflow-hidden rounded-lg">
                    <Image
                      src={article.imageUrl}
                      alt={article.articleTitle || "Article cover"}
                      fill
                      className="object-cover"
                      sizes="(max-width: 768px) 100vw, (max-width: 1200px) 50vw, 800px"
                      priority
                    />
                  </div>
                )}

                {/* Article title */}
                <h1 className="mb-4 font-bold text-3xl text-foreground leading-tight sm:text-4xl">
                  {article.articleTitle}
                </h1>

                {/* Article metadata */}
                <div className="mb-6 flex flex-wrap items-center gap-3 text-muted-foreground text-sm">
                  <span className="font-semibold text-[#0066FF]">
                    {article.authorName}
                  </span>
                  {article.byline && (
                    <>
                      <span>·</span>
                      <span>{article.byline}</span>
                    </>
                  )}
                  <span>·</span>
                  <time>
                    {publishedDate.toLocaleDateString("en-US", {
                      month: "long",
                      day: "numeric",
                      year: "numeric",
                    })}
                  </time>
                </div>

                {/* Full article content with markdown rendering */}
                <Response className="mb-6 max-w-none text-foreground/90 [&_a]:text-[#0066FF] [&_a]:underline hover:[&_a]:text-[#0066FF]/80 [&_blockquote]:my-6 [&_blockquote]:border-[#0066FF] [&_blockquote]:border-l-4 [&_blockquote]:pl-4 [&_blockquote]:text-muted-foreground [&_blockquote]:italic [&_code]:rounded [&_code]:bg-muted [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-sm [&_em]:italic [&_h1]:mt-8 [&_h1]:mb-4 [&_h1]:font-bold [&_h1]:text-2xl [&_h2]:mt-6 [&_h2]:mb-3 [&_h2]:font-semibold [&_h2]:text-xl [&_h3]:mt-4 [&_h3]:mb-2 [&_h3]:font-medium [&_h3]:text-lg [&_hr]:my-8 [&_hr]:border-border [&_li]:my-2 [&_li]:text-base [&_li]:leading-relaxed [&_ol]:my-4 [&_ol]:list-decimal [&_ol]:pl-6 [&_p]:mb-6 [&_p]:text-base [&_p]:leading-relaxed sm:[&_p]:text-lg [&_pre]:my-4 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-muted [&_pre]:p-4 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_strong]:font-bold [&_ul]:my-4 [&_ul]:list-disc [&_ul]:pl-6">
                  {articleBody}
                </Response>
              </article>

              {/* Spacer for login bar */}
              <div className="pb-24" />
            </div>
          </div>
        </div>

        {/* Right sidebar - More Articles (desktop only) */}
        <div className="hidden w-96 flex-none flex-col xl:flex">
          <div className="flex w-96 flex-col px-4 py-6">
            <MoreArticlesWidget currentArticleId={articleId} limit={5} />
          </div>
        </div>

        {/* Mobile/Tablet: Single column layout */}
        <div className="flex flex-1 flex-col overflow-hidden lg:hidden">
          {/* Mobile header */}
          <div className="sticky top-0 z-10 shrink-0 border-border border-b bg-background">
            <div className="flex items-center gap-4 px-4 py-3">
              <button
                onClick={() => router.back()}
                className="rounded-full p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <ArrowLeft size={20} />
              </button>
              <div className="flex items-center gap-2">
                <Newspaper className="h-5 w-5 text-[#0066FF]" />
                <h1 className="font-semibold text-lg">Article</h1>
              </div>
            </div>
          </div>

          {/* Mobile content */}
          <div className="flex-1 overflow-y-auto">
            <article className="px-4 py-4 sm:px-6 sm:py-5">
              {/* Article cover image */}
              {article.imageUrl && (
                <div className="relative mb-4 aspect-video w-full overflow-hidden rounded-lg">
                  <Image
                    src={article.imageUrl}
                    alt={article.articleTitle || "Article cover"}
                    fill
                    className="object-cover"
                    sizes="100vw"
                    priority
                  />
                </div>
              )}

              {/* Article title */}
              <h1 className="mb-4 font-bold text-2xl text-foreground leading-tight sm:text-3xl">
                {article.articleTitle}
              </h1>

              {/* Article metadata */}
              <div className="mb-4 flex flex-wrap items-center gap-2 text-muted-foreground text-sm">
                <span className="font-semibold text-[#0066FF]">
                  {article.authorName}
                </span>
                {article.byline && (
                  <>
                    <span>·</span>
                    <span>{article.byline}</span>
                  </>
                )}
                <span>·</span>
                <time>
                  {publishedDate.toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                  })}
                </time>
              </div>

              {/* Full article content with markdown rendering */}
              <Response className="mb-4 max-w-none text-foreground/90 [&_a]:text-[#0066FF] [&_a]:underline hover:[&_a]:text-[#0066FF]/80 [&_blockquote]:my-4 [&_blockquote]:border-[#0066FF] [&_blockquote]:border-l-4 [&_blockquote]:pl-4 [&_blockquote]:text-muted-foreground [&_blockquote]:italic [&_code]:rounded [&_code]:bg-muted [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-sm [&_em]:italic [&_h1]:mt-6 [&_h1]:mb-3 [&_h1]:font-bold [&_h1]:text-xl [&_h2]:mt-5 [&_h2]:mb-2 [&_h2]:font-semibold [&_h2]:text-lg [&_h3]:mt-4 [&_h3]:mb-2 [&_h3]:font-medium [&_h3]:text-base [&_hr]:my-6 [&_hr]:border-border [&_li]:my-1.5 [&_li]:text-base [&_li]:leading-relaxed [&_ol]:my-3 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:mb-5 [&_p]:text-base [&_p]:leading-relaxed [&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-muted [&_pre]:p-3 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_strong]:font-bold [&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-5">
                {articleBody}
              </Response>

              {/* More Articles - Mobile */}
              <div className="mt-8 border-border border-t pt-6">
                <MoreArticlesWidget currentArticleId={articleId} limit={4} />
              </div>

              {/* Spacer for login bar */}
              <div className="pb-24" />
            </article>
          </div>
        </div>
      </div>
    </PageContainer>
  );
}
