import type { Metadata } from "next";
import { getCurrentUser } from "@/lib/auth";
import { listCharacters } from "@/app/actions/characters";
import { KnowledgePageClient } from "@/components/knowledge/knowledge-page-client";
import { generatePageMetadata } from "@/lib/seo";

export const metadata: Metadata = generatePageMetadata({
  title: "File Management - elizaOS Cloud",
  description:
    "Upload and manage documents for your agents. These files provide context and information for enhanced AI responses.",
  path: "/dashboard/knowledge",
  noIndex: true,
});

// Force dynamic rendering since we use server-side auth (cookies)
export const dynamic = "force-dynamic";

/**
 * File Management page for uploading and managing agent documents.
 * Allows users to upload documents and query them for enhanced AI responses.
 *
 * @returns The rendered knowledge page client component, or an authentication required message.
 */
export default async function KnowledgePage() {
  // Check if user is authenticated
  const user = await getCurrentUser();

  if (!user) {
    // Redirect to login if not authenticated
    return (
      <div className="container mx-auto py-8">
        <div className="text-center">
          <h1 className="text-2xl font-bold mb-4">Authentication Required</h1>
          <p className="text-muted-foreground">
            Please log in to manage your files.
          </p>
        </div>
      </div>
    );
  }

  // Load user's characters
  const characters = await listCharacters();

  return <KnowledgePageClient initialCharacters={characters} />;
}
