import matter from "gray-matter";

type RawPostModule = string | { default: string };

const postModules = import.meta.glob<RawPostModule>("../content/blog/*.{md,mdx}", {
  eager: true,
  query: "?raw",
});

export interface BlogPost {
  slug: string;
  title: string;
  date: string;
  author: string;
  description: string;
  category: string;
  image?: string;
  content: string;
  relatedPosts?: string[];
}

export interface BlogPostMeta {
  slug: string;
  title: string;
  date: string;
  author: string;
  description: string;
  category: string;
  image?: string;
}

function slugFromGlobKey(globKey: string): string {
  const fileName = globKey.split("/").pop() ?? globKey;
  return fileName.replace(/\.mdx?$/, "");
}

function rawContentFromModule(module: RawPostModule): string {
  return typeof module === "string" ? module : module.default;
}

function getPostEntries(): Array<[string, string]> {
  return Object.entries(postModules)
    .filter(([globKey]) => {
      const fileName = globKey.split("/").pop() ?? "";
      return !fileName.startsWith("_");
    })
    .map(([globKey, module]) => [globKey, rawContentFromModule(module)]);
}

export function getAllPosts(): BlogPostMeta[] {
  const posts = getPostEntries()
    .map(([globKey, fileContent]) => {
      const { data } = matter(fileContent);

      return {
        slug: slugFromGlobKey(globKey),
        title: data.title || "Untitled",
        date: data.date || "",
        author: data.author || "Anonymous",
        description: data.description || "",
        category: data.category || "uncategorized",
        image: data.image,
      };
    })
    .sort((a, b) => {
      const dateA = new Date(a.date).getTime();
      const dateB = new Date(b.date).getTime();
      // Handle invalid dates by treating them as oldest
      if (isNaN(dateB)) return -1;
      if (isNaN(dateA)) return 1;
      return dateB - dateA;
    });

  return posts;
}

export function getPostBySlug(slug: string): BlogPost | null {
  const entry = getPostEntries().find(([globKey]) => slugFromGlobKey(globKey) === slug);
  if (!entry) return null;

  const [, fileContent] = entry;
  const { data, content } = matter(fileContent);

  return {
    slug,
    title: data.title || "Untitled",
    date: data.date || "",
    author: data.author || "Anonymous",
    description: data.description || "",
    category: data.category || "uncategorized",
    image: data.image,
    content,
    relatedPosts: data.relatedPosts,
  };
}

export function getPostsByCategory(category: string): BlogPostMeta[] {
  const allPosts = getAllPosts();
  return allPosts.filter((post) => post.category === category);
}

export function getCategories(): string[] {
  const allPosts = getAllPosts();
  const categories = new Set(allPosts.map((post) => post.category));
  return Array.from(categories).sort();
}

// Exclude demo posts from public listing
export function getPublicPosts(): BlogPostMeta[] {
  return getAllPosts().filter((post) => post.category !== "demo");
}

// Exclude demo from public category list
export function getPublicCategories(): string[] {
  return getCategories().filter((category) => category !== "demo");
}

export function getAllSlugs(): string[] {
  return getPostEntries().map(([globKey]) => slugFromGlobKey(globKey));
}

export function getPostsBySlugs(slugs: string[]): BlogPostMeta[] {
  const allPosts = getAllPosts();
  return slugs
    .map((slug) => allPosts.find((post) => post.slug === slug))
    .filter((post): post is BlogPostMeta => post !== undefined);
}
