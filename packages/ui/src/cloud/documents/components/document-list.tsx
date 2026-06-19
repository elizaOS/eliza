/**
 * Document list table for the per-character knowledge view. Displays document
 * metadata with relative timestamps and a confirm-gated delete.
 *
 * Ported from `@elizaos/cloud-frontend/src/dashboard/documents/_components/document-list.tsx`.
 * Primitives now come from the canonical `components/ui/*` layer (relative
 * imports, since this lives inside `@elizaos/ui`); the document type comes from
 * the canonical `@elizaos/cloud-shared` DTO; translations from the cloud shell.
 */

import type { CloudDocument } from "@elizaos/cloud-shared/lib/types/documents";
import { formatDistanceToNow } from "date-fns";
import { FileText, Loader2, RefreshCw, Trash2 } from "lucide-react";
import { useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../../../components/ui/alert-dialog";
import { Button } from "../../../components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../../components/ui/table";
import { useCloudT } from "../../shell/CloudI18nProvider";

interface DocumentListProps {
  documents: CloudDocument[];
  loading: boolean;
  onDelete: (documentId: string) => Promise<void>;
  onRefresh: () => void;
}

export function DocumentList({
  documents,
  loading,
  onDelete,
  onRefresh,
}: DocumentListProps) {
  const t = useCloudT();
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [documentToDelete, setDocumentToDelete] =
    useState<CloudDocument | null>(null);
  const [deleting, setDeleting] = useState(false);

  const handleDeleteClick = (doc: CloudDocument) => {
    setDocumentToDelete(doc);
    setDeleteDialogOpen(true);
  };

  const handleDeleteConfirm = async () => {
    if (!documentToDelete) return;
    setDeleting(true);
    await onDelete(documentToDelete.id);
    setDeleteDialogOpen(false);
    setDocumentToDelete(null);
    setDeleting(false);
  };

  const getDocumentName = (doc: CloudDocument): string =>
    doc.metadata?.fileName ||
    doc.metadata?.originalFilename ||
    t("cloud.documents.list.fallbackName", {
      defaultValue: "Document {{id}}",
      id: doc.id.slice(0, 8),
    });

  const getDocumentSize = (doc: CloudDocument): string => {
    const size = doc.metadata?.fileSize;
    if (!size)
      return t("cloud.documents.list.unknownSize", { defaultValue: "Unknown" });
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(2)} KB`;
    return `${(size / (1024 * 1024)).toFixed(2)} MB`;
  };

  const getDocumentAge = (doc: CloudDocument): string => {
    const timestamp = doc.metadata?.uploadedAt || doc.createdAt;
    return formatDistanceToNow(new Date(timestamp), { addSuffix: true });
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (documents.length === 0) {
    return (
      <div className="text-center py-12">
        <FileText className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
        <h3 className="text-lg font-semibold mb-2">
          {t("cloud.documents.list.emptyTitle", {
            defaultValue: "No files yet",
          })}
        </h3>
        <p className="text-muted-foreground mb-4">
          {t("cloud.documents.list.emptyBody", {
            defaultValue: "Upload your first file to get started.",
          })}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <p className="text-sm text-muted-foreground">
          {documents.length}{" "}
          {documents.length !== 1
            ? t("cloud.documents.list.documentsPlural", {
                defaultValue: "documents",
              })
            : t("cloud.documents.list.documentSingular", {
                defaultValue: "document",
              })}
        </p>
        <Button variant="outline" size="sm" onClick={onRefresh}>
          <RefreshCw className="h-4 w-4 mr-2" />
          {t("cloud.documents.list.refresh", { defaultValue: "Refresh" })}
        </Button>
      </div>

      <div className="border rounded-sm">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>
                {t("cloud.documents.list.col.name", { defaultValue: "Name" })}
              </TableHead>
              <TableHead>
                {t("cloud.documents.list.col.size", { defaultValue: "Size" })}
              </TableHead>
              <TableHead>
                {t("cloud.documents.list.col.uploaded", {
                  defaultValue: "Uploaded",
                })}
              </TableHead>
              <TableHead className="text-right">
                {t("cloud.documents.list.col.actions", {
                  defaultValue: "Actions",
                })}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {documents.map((doc) => (
              <TableRow key={doc.id}>
                <TableCell className="font-medium">
                  <div className="flex items-center gap-2">
                    <FileText className="h-4 w-4 text-muted-foreground" />
                    <span className="truncate max-w-[300px]">
                      {getDocumentName(doc)}
                    </span>
                  </div>
                </TableCell>
                <TableCell>{getDocumentSize(doc)}</TableCell>
                <TableCell className="text-muted-foreground">
                  {getDocumentAge(doc)}
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleDeleteClick(doc)}
                  >
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("cloud.documents.list.deleteTitle", {
                defaultValue: "Delete Document",
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("cloud.documents.list.deleteConfirm", {
                defaultValue:
                  'Are you sure you want to delete "{{name}}"? This action cannot be undone.',
                name: documentToDelete ? getDocumentName(documentToDelete) : "",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>
              {t("cloud.documents.list.cancel", { defaultValue: "Cancel" })}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteConfirm}
              disabled={deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {t("cloud.documents.list.deleting", {
                    defaultValue: "Deleting...",
                  })}
                </>
              ) : (
                t("cloud.documents.list.delete", { defaultValue: "Delete" })
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
