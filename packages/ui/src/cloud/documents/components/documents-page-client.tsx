/**
 * Per-character knowledge surface: a character scope selector + three tabs
 * (Documents / Upload / Query).
 *
 * Ported from `@elizaos/cloud-frontend/src/dashboard/documents/_components/documents-page-client.tsx`.
 * The page's hand-rolled `PageState` + raw `fetch()` loading/error/503 machine
 * is replaced by the typed `useDocuments` / `useDeleteDocument` hooks: list
 * data, loading, and the service-unavailable (503) branch all come from
 * react-query, and delete invalidates the list (no manual refetch wiring).
 */

import { Bot, InfoIcon, List, Search, Upload } from "lucide-react";
import { useEffect, useState } from "react";
import { DashboardSection } from "../../../cloud-ui/components/brand/dashboard-section";
import { Alert, AlertDescription } from "../../../components/ui/alert";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "../../../components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../../components/ui/select";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "../../../components/ui/tabs";
import { useCloudT } from "../../shell/CloudI18nProvider";
import { useDeleteDocument, useDocuments } from "../lib/documents";
import { DocumentList } from "./document-list";
import { DocumentQuery } from "./document-query";
import { DocumentUpload } from "./document-upload";

export interface DocumentsPageCharacter {
  id: string;
  name: string;
}

interface DocumentsPageClientProps {
  initialCharacters: DocumentsPageCharacter[];
}

export function DocumentsPageClient({
  initialCharacters,
}: DocumentsPageClientProps) {
  const t = useCloudT();
  const [activeTab, setActiveTab] = useState("documents");
  const [isMounted, setIsMounted] = useState(false);
  const [selectedCharacterId, setSelectedCharacterId] = useState<string | null>(
    initialCharacters.length > 0 ? (initialCharacters[0].id ?? null) : null,
  );

  const documentsQuery = useDocuments(selectedCharacterId);
  const deleteDocument = useDeleteDocument(selectedCharacterId);

  useEffect(() => {
    setIsMounted(true);
  }, []);

  const listState = documentsQuery.data;
  const serviceUnavailable = listState?.status === "service-unavailable";
  const documents = listState?.status === "ok" ? listState.documents : [];
  const loading = selectedCharacterId !== null && documentsQuery.isLoading;
  const listError =
    documentsQuery.error instanceof Error ? documentsQuery.error.message : null;

  const handleDelete = async (documentId: string) => {
    await deleteDocument.mutateAsync(documentId);
  };

  if (serviceUnavailable && !loading) {
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
            {listState.message && (
              <p className="text-sm mt-1">{listState.message}</p>
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

        {initialCharacters.length > 0 && (
          <Select
            value={selectedCharacterId || undefined}
            onValueChange={(v) => setSelectedCharacterId(v)}
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

        {!selectedCharacterId && initialCharacters.length > 0 && (
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
        value={activeTab}
        onValueChange={(v: string) => setActiveTab(v)}
        className="w-full"
      >
        {/* Mobile dropdown */}
        {isMounted && (
          <div className="block md:hidden mb-4">
            <Select value={activeTab} onValueChange={(v) => setActiveTab(v)}>
              <SelectTrigger className="w-full">
                <SelectValue>
                  <div className="flex items-center gap-2">
                    {activeTab === "documents" && (
                      <>
                        <List className="h-4 w-4" />
                        <span>
                          {t("cloud.documents.tab.documents", {
                            defaultValue: "Documents",
                          })}
                        </span>
                      </>
                    )}
                    {activeTab === "upload" && (
                      <>
                        <Upload className="h-4 w-4" />
                        <span>
                          {t("cloud.documents.tab.upload", {
                            defaultValue: "Upload",
                          })}
                        </span>
                      </>
                    )}
                    {activeTab === "query" && (
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

        {/* Desktop tabs */}
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
              {listError ? (
                <Alert variant="destructive">
                  <AlertDescription>{listError}</AlertDescription>
                </Alert>
              ) : (
                <DocumentList
                  documents={documents}
                  loading={loading}
                  onDelete={handleDelete}
                  onRefresh={() => void documentsQuery.refetch()}
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
                onUploadSuccess={() => void documentsQuery.refetch()}
                characterId={selectedCharacterId}
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
              <DocumentQuery characterId={selectedCharacterId} />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
