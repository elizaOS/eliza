/**
 * Documents page client component for managing document uploads and queries.
 * Provides tabs for uploading documents, viewing document lists, and querying document content.
 *
 * @param props - Documents page configuration
 * @param props.initialCharacters - Initial list of characters for document association
 */

"use client";

import {
  Alert,
  AlertDescription,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  DashboardSection,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@elizaos/ui";
import { Bot, InfoIcon, List, Search, Upload } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { ElizaCharacter } from "@/lib/types";
import type { CloudDocument } from "@/lib/types/documents";
import { useT } from "@/providers/I18nProvider";
import { DocumentList } from "./document-list";
import { DocumentQuery } from "./document-query";
import { DocumentUpload } from "./document-upload";

interface DocumentsPageClientProps {
  initialCharacters: ElizaCharacter[];
}

interface PageState {
  documents: CloudDocument[];
  loading: boolean;
  error: string | null;
  serviceAvailable: boolean;
  activeTab: string;
  isMounted: boolean;
  selectedCharacterId: string | null;
}

export function DocumentsPageClient({
  initialCharacters,
}: DocumentsPageClientProps) {
  const t = useT();
  const [pageState, setPageState] = useState<PageState>({
    documents: [],
    loading: true,
    error: null,
    serviceAvailable: true,
    activeTab: "documents",
    isMounted: false,
    selectedCharacterId:
      initialCharacters.length > 0 ? (initialCharacters[0].id ?? null) : null,
  });

  const updatePageState = useCallback((updates: Partial<PageState>) => {
    setPageState((prev) => ({ ...prev, ...updates }));
  }, []);

  const fetchDocuments = useCallback(async () => {
    updatePageState({ loading: true, error: null });

    // Include characterId in query params
    const url = new URL("/api/v1/documents", window.location.origin);
    if (pageState.selectedCharacterId) {
      url.searchParams.set("characterId", pageState.selectedCharacterId);
    }

    const response = await fetch(url.toString());

    if (response.status === 503) {
      const data = await response.json();
      updatePageState({
        error:
          data.error ||
          t("cloud.documents.error.serviceUnavailable", {
            defaultValue: "Knowledge service is not available",
          }),
        serviceAvailable: false,
        loading: false,
      });
      return;
    }

    if (!response.ok) {
      const data = await response.json();
      throw new Error(
        data.details ||
          data.error ||
          t("cloud.documents.error.fetchFailed", {
            defaultValue: "Failed to fetch documents",
          }),
      );
    }

    const data = await response.json();
    updatePageState({
      documents: data.documents || [],
      serviceAvailable: true,
      loading: false,
    });
  }, [pageState.selectedCharacterId, updatePageState, t]);

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
      `/api/v1/documents/${documentId}`,
      window.location.origin,
    );
    if (pageState.selectedCharacterId) {
      url.searchParams.set("characterId", pageState.selectedCharacterId);
    }

    const response = await fetch(url.toString(), {
      method: "DELETE",
    });

    if (!response.ok) {
      throw new Error(
        t("cloud.documents.error.deleteFailed", {
          defaultValue: "Failed to delete document",
        }),
      );
    }

    // Refresh the list
    fetchDocuments();
  };

  if (!pageState.serviceAvailable && !pageState.loading) {
    return (
      <div className="container mx-auto py-8 space-y-4">
        <DashboardSection
          label={t("cloud.documents.section.label", {
            defaultValue: "Knowledge",
          })}
          title={t("cloud.documents.section.title", {
            defaultValue: "File Management",
          })}
          description={t("cloud.documents.section.descShort", {
            defaultValue:
              "Upload, index, and query agent documents from a single surface.",
          })}
        />
        <Alert variant="destructive">
          <InfoIcon className="h-4 w-4" />
          <AlertDescription>
            <p className="font-semibold">
              {t("cloud.documents.serviceUnavailable", {
                defaultValue: "Service unavailable",
              })}
            </p>
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
        <DashboardSection
          label={t("cloud.documents.section.label", {
            defaultValue: "Knowledge",
          })}
          title={t("cloud.documents.section.title", {
            defaultValue: "File Management",
          })}
          description={t("cloud.documents.section.descLong", {
            defaultValue:
              "Upload and manage documents for your agents. These files provide context and information for enhanced AI responses.",
          })}
        />

        {/* Character Selector */}
        {initialCharacters.length > 0 && (
          <Select
            value={pageState.selectedCharacterId || undefined}
            onValueChange={(v) => updatePageState({ selectedCharacterId: v })}
          >
            <SelectTrigger className="w-full max-w-xs">
              <Bot className="h-4 w-4 mr-2" />
              <SelectValue
                placeholder={t("cloud.documents.selectAgent", {
                  defaultValue: "Select agent...",
                })}
              />
            </SelectTrigger>
            <SelectContent>
              {initialCharacters.map((char) =>
                char.id ? (
                  <SelectItem key={char.id} value={char.id}>
                    {char.name}
                  </SelectItem>
                ) : null,
              )}
            </SelectContent>
          </Select>
        )}

        {!pageState.selectedCharacterId && initialCharacters.length > 0 && (
          <Alert>
            <InfoIcon className="h-4 w-4" />
            <AlertDescription>
              {t("cloud.documents.pleaseSelectAgent", {
                defaultValue: "Please select an agent to manage its files.",
              })}
            </AlertDescription>
          </Alert>
        )}
      </div>

      <Tabs
        id="documents-tabs"
        value={pageState.activeTab}
        onValueChange={(v: string) => updatePageState({ activeTab: v })}
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
                        <span>
                          {t("cloud.documents.tab.documents", {
                            defaultValue: "Documents",
                          })}
                        </span>
                      </>
                    )}
                    {pageState.activeTab === "upload" && (
                      <>
                        <Upload className="h-4 w-4" />
                        <span>
                          {t("cloud.documents.tab.upload", {
                            defaultValue: "Upload",
                          })}
                        </span>
                      </>
                    )}
                    {pageState.activeTab === "query" && (
                      <>
                        <Search className="h-4 w-4" />
                        <span>
                          {t("cloud.documents.tab.query", {
                            defaultValue: "Query",
                          })}
                        </span>
                      </>
                    )}
                  </div>
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="documents">
                  <div className="flex items-center gap-2">
                    <List className="h-4 w-4" />
                    {t("cloud.documents.tab.documents", {
                      defaultValue: "Documents",
                    })}
                  </div>
                </SelectItem>
                <SelectItem value="upload">
                  <div className="flex items-center gap-2">
                    <Upload className="h-4 w-4" />
                    {t("cloud.documents.tab.upload", {
                      defaultValue: "Upload",
                    })}
                  </div>
                </SelectItem>
                <SelectItem value="query">
                  <div className="flex items-center gap-2">
                    <Search className="h-4 w-4" />
                    {t("cloud.documents.tab.query", { defaultValue: "Query" })}
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
            {t("cloud.documents.tab.documents", { defaultValue: "Documents" })}
          </TabsTrigger>
          <TabsTrigger value="upload">
            <Upload className="h-4 w-4 mr-2" />
            {t("cloud.documents.tab.upload", { defaultValue: "Upload" })}
          </TabsTrigger>
          <TabsTrigger value="query">
            <Search className="h-4 w-4 mr-2" />
            {t("cloud.documents.tab.query", { defaultValue: "Query" })}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="documents" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>
                {t("cloud.documents.uploadedFiles", {
                  defaultValue: "Uploaded Files",
                })}
              </CardTitle>
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
              <CardTitle>
                {t("cloud.documents.uploadDocuments", {
                  defaultValue: "Upload Documents",
                })}
              </CardTitle>
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
              <CardTitle>
                {t("cloud.documents.searchFiles", {
                  defaultValue: "Search Files",
                })}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <DocumentQuery characterId={pageState.selectedCharacterId} />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
