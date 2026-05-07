import { Helmet } from "react-helmet-async";
import ReactMarkdown from "react-markdown";
import { Link, useParams } from "react-router-dom";
import remarkGfm from "remark-gfm";
import { getPostBySlug, getPostsBySlugs } from "@/lib/blog";
import BlogPost from "../../../components/landing/BlogPost";
import { BlogPage } from "../../../components/landing/blog-page";
import RelatedPosts from "../../../components/landing/RelatedPosts";
import Tweet from "../../../components/landing/Tweet";

const BASE_URL = import.meta.env.VITE_APP_URL ?? "https://www.elizacloud.ai";

export default function BlogPostPage() {
  const { slug } = useParams<{ slug: string }>();
  const post = slug ? getPostBySlug(slug) : null;

  if (!post) {
    return (
      <BlogPage>
        <div className="flex-1 px-4 pt-24 pb-12 text-center text-white">
          <Helmet>
            <title>Post Not Found | Eliza Cloud</title>
            <meta name="robots" content="noindex" />
          </Helmet>
          <h1 className="text-3xl font-semibold">Post not found</h1>
          <p className="mt-4 text-white/60">
            We couldn’t find that blog post.{" "}
            <Link to="/blog" className="underline">
              Back to the blog index
            </Link>
            .
          </p>
        </div>
      </BlogPage>
    );
  }

  const ogImage = post.image || "/cloudlogo.png";
  const absoluteImageUrl = ogImage.startsWith("http") ? ogImage : `${BASE_URL}${ogImage}`;
  const relatedPosts = post.relatedPosts ? getPostsBySlugs(post.relatedPosts) : [];

  return (
    <BlogPage>
      <Helmet>
        <title>{post.title} | Eliza Cloud</title>
        <meta name="description" content={post.description} />
        <meta property="og:title" content={post.title} />
        <meta property="og:description" content={post.description} />
        <meta property="og:type" content="article" />
        <meta property="article:published_time" content={post.date} />
        <meta property="article:author" content={post.author} />
        <meta property="og:image" content={absoluteImageUrl} />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content={post.title} />
        <meta name="twitter:description" content={post.description} />
        <meta name="twitter:image" content={absoluteImageUrl} />
        <meta name="twitter:creator" content="@elizaos" />
        <meta name="twitter:site" content="@elizaos" />
      </Helmet>
      <BlogPost
        title={post.title}
        date={post.date}
        author={post.author}
        category={post.category}
        image={post.image}
      >
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ Tweet } as never}>
          {post.content}
        </ReactMarkdown>
      </BlogPost>
      {relatedPosts.length > 0 && (
        <div className="w-full bg-black px-6">
          <RelatedPosts posts={relatedPosts} />
        </div>
      )}
    </BlogPage>
  );
}
