/**
 * Knowledge page client component for managing knowledge documents and queries.
 * Provides tabs for uploading documents, viewing document lists, and querying knowledge base.
 *
 * @param props - Knowledge page configuration
 * @param props.initialCharacters - Initial list of characters for document association
 */

"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DocumentUpload } from "./document-upload";
import { DocumentList } from "./document-list";
import { KnowledgeQuery } from "./knowledge-query";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { InfoIcon, Upload, Search, List, Bot } from "lucide-react";
import type { ElizaCharacter } from "@/lib/types";

import type { KnowledgeDocument } from "@/lib/types/knowledge";

interface KnowledgePageClientProps {
  initialCharacters: ElizaCharacter[];
}

interface PageState {
  documents: KnowledgeDocument[];
  loading: boolean;
  error: string | null;
  serviceAvailable: boolean;
  activeTab: string;
  isMounted: boolean;
  selectedCharacterId: string | null;
}

export function KnowledgePageClient({
  initialCharacters,
}: KnowledgePageClientProps) {
  const [pageState, setPageState] = useState<PageState>({
    documents: [],
    loading: true,
    error: null,
    serviceAvailable: true,
    activeTab: "documents",
    isMounted: false,
    selectedCharacterId:
      initialCharacters.length > 0 ? initialCharacters[0].id! : null,
  });

  const updatePageState = useCallback((updates: Partial<PageState>) => {
    setPageState((prev) => ({ ...prev, ...updates }));
  }, []);

  const fetchDocuments = useCallback(async () => {
    updatePageState({ loading: true, error: null });

    // Include characterId in query params
    const url = new URL("/api/v1/knowledge", window.location.origin);
    if (pageState.selectedCharacterId) {
      url.searchParams.set("characterId", pageState.selectedCharacterId);
    }

    const response = await fetch(url.toString());

    if (response.status === 503) {
      const data = await response.json();
      updatePageState({
        error: data.error || "Knowledge service is not available",
        serviceAvailable: false,
        loading: false,
      });
      return;
    }

    if (!response.ok) {
      const data = await response.json();
      throw new Error(
        data.details || data.error || "Failed to fetch documents",
      );
    }

    const data = await response.json();
    updatePageState({
      documents: data.documents || [],
      serviceAvailable: true,
      loading: false,
    });
  }, [pageState.selectedCharacterId, updatePageState]);

  useEffect(() => {
    if (pageState.selectedCharacterId) {
      // Use queueMicrotask to defer execution and avoid synchronous setState
      queueMicrotask(() => {
        fetchDocuments();
      });
    }
  }, [pageState.selectedCharacterId, fetchDocuments]);

  useEffect(() => {
    // Use queueMicrotask to defer execution and avoid synchronous setState
    queueMicrotask(() => {
      updatePageState({ isMounted: true });
    });
  }, [updatePageState]);

  const handleUploadSuccess = () => {
    fetchDocuments();
  };

  const handleDelete = async (documentId: string) => {
    // Include characterId in query params
    const url = new URL(
      `/api/v1/knowledge/${documentId}`,
      window.location.origin,
    );
    if (pageState.selectedCharacterId) {
      url.searchParams.set("characterId", pageState.selectedCharacterId);
    }

    const response = await fetch(url.toString(), {
      method: "DELETE",
    });

    if (!response.ok) {
      throw new Error("Failed to delete document");
    }

    // Refresh the list
    fetchDocuments();
  };

  if (!pageState.serviceAvailable && !pageState.loading) {
    return (
      <div className="container mx-auto py-8 space-y-4">
        <h1 className="text-2xl font-bold">File Management</h1>
        <Alert variant="destructive">
          <InfoIcon className="h-4 w-4" />
          <AlertDescription>
            <p className="font-semibold">Service unavailable</p>
            {pageState.error && (
              <p className="text-sm mt-1">{pageState.error}</p>
            )}
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="container mx-auto py-8 space-y-6">
      <div className="space-y-4">
        <div>
          <h1 className="text-3xl font-bold">File Management</h1>
          <p className="text-muted-foreground mt-2">
            Upload and manage documents for your agents. These files provide
            context and information for enhanced AI responses.
          </p>
        </div>

        {/* Character Selector */}
        {initialCharacters.length > 0 && (
          <Select
            value={pageState.selectedCharacterId || undefined}
            onValueChange={(v) => updatePageState({ selectedCharacterId: v })}
          >
            <SelectTrigger className="w-full max-w-xs">
              <Bot className="h-4 w-4 mr-2" />
              <SelectValue placeholder="Select agent..." />
            </SelectTrigger>
            <SelectContent>
              {initialCharacters.map((char) => (
                <SelectItem key={char.id} value={char.id!}>
                  {char.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        {!pageState.selectedCharacterId && initialCharacters.length > 0 && (
          <Alert>
            <InfoIcon className="h-4 w-4" />
            <AlertDescription>
              Please select an agent to manage its files.
            </AlertDescription>
          </Alert>
        )}
      </div>

      <Tabs
        id="knowledge-tabs"
        value={pageState.activeTab}
        onValueChange={(v) => updatePageState({ activeTab: v })}
        className="w-full"
      >
        {/* Mobile Dropdown */}
        {pageState.isMounted && (
          <div className="block md:hidden mb-4">
            <Select
              value={pageState.activeTab}
              onValueChange={(v) => updatePageState({ activeTab: v })}
            >
              <SelectTrigger className="w-full">
                <SelectValue>
                  <div className="flex items-center gap-2">
                    {pageState.activeTab === "documents" && (
                      <>
                        <List className="h-4 w-4" />
                        <span>Documents</span>
                      </>
                    )}
                    {pageState.activeTab === "upload" && (
                      <>
                        <Upload className="h-4 w-4" />
                        <span>Upload</span>
                      </>
                    )}
                    {pageState.activeTab === "query" && (
                      <>
                        <Search className="h-4 w-4" />
                        <span>Query</span>
                      </>
                    )}
                  </div>
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="documents">
                  <div className="flex items-center gap-2">
                    <List className="h-4 w-4" />
                    Documents
                  </div>
                </SelectItem>
                <SelectItem value="upload">
                  <div className="flex items-center gap-2">
                    <Upload className="h-4 w-4" />
                    Upload
                  </div>
                </SelectItem>
                <SelectItem value="query">
                  <div className="flex items-center gap-2">
                    <Search className="h-4 w-4" />
                    Query
                  </div>
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}

        {/* Desktop Tabs */}
        <TabsList className="hidden md:grid w-full grid-cols-3">
          <TabsTrigger value="documents">
            <List className="h-4 w-4 mr-2" />
            Documents
          </TabsTrigger>
          <TabsTrigger value="upload">
            <Upload className="h-4 w-4 mr-2" />
            Upload
          </TabsTrigger>
          <TabsTrigger value="query">
            <Search className="h-4 w-4 mr-2" />
            Query
          </TabsTrigger>
        </TabsList>

        <TabsContent value="documents" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Uploaded Files</CardTitle>
            </CardHeader>
            <CardContent>
              {pageState.error ? (
                <Alert variant="destructive">
                  <AlertDescription>{pageState.error}</AlertDescription>
                </Alert>
              ) : (
                <DocumentList
                  documents={pageState.documents}
                  loading={pageState.loading}
                  onDelete={handleDelete}
                  onRefresh={fetchDocuments}
                />
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="upload" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Upload Documents</CardTitle>
            </CardHeader>
            <CardContent>
              <DocumentUpload
                onUploadSuccess={handleUploadSuccess}
                characterId={pageState.selectedCharacterId}
              />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="query" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Search Files</CardTitle>
            </CardHeader>
            <CardContent>
              <KnowledgeQuery characterId={pageState.selectedCharacterId} />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
