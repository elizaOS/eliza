"use client";

import { Button, Input } from "@elizaos/cloud-ui";
import { formatDistanceToNow } from "date-fns";
import { FileText, Loader2, RefreshCw, Trash2, Upload } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { KnowledgeDocument, PreUploadedFile } from "@/lib/types/knowledge";

interface UploadsTabProps {
  characterId: string | null;
  preUploadedFiles?: PreUploadedFile[];
  onPreUploadedFilesAdd?: (files: PreUploadedFile[]) => void;
  onPreUploadedFileRemove?: (fileId: string) => void;
}

export function UploadsTab({
  characterId,
  preUploadedFiles = [],
  onPreUploadedFilesAdd,
  onPreUploadedFileRemove,
}: UploadsTabProps) {
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [_selectedFiles, setSelectedFiles] = useState<File[]>([]);

  // Track concurrent uploads to prevent premature "uploading = false" state
  const activeUploadsRef = useRef(0);

  const fetchDocuments = useCallback(async () => {
    if (!characterId) return;
    setLoading(true);

    const url = new URL("/api/v1/knowledge", window.location.origin);
    url.searchParams.set("characterId", characterId);

    const response = await fetch(url.toString(), { credentials: "include" });
    if (response.ok) {
      const data = await response.json();
      setDocuments(data.documents || []);
    }
    setLoading(false);
  }, [characterId]);

  useEffect(() => {
    if (characterId) {
      // Schedule fetch to avoid synchronous setState in effect
      const rafId = requestAnimationFrame(() => {
        void fetchDocuments();
      });
      return () => cancelAnimationFrame(rafId);
    }
  }, [characterId, fetchDocuments]);

  const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB per file
  const MAX_BATCH_SIZE = 5 * 1024 * 1024; // 5MB total per batch

  const handleUpload = async (files: File[]) => {
    if (files.length === 0) return;

    // Check individual file sizes first for better error messages
    for (const file of files) {
      if (file.size > MAX_FILE_SIZE) {
        const fileMB = (file.size / (1024 * 1024)).toFixed(1);
        toast.error("File too large", {
          description: `"${file.name}" (${fileMB}MB) exceeds 5MB limit.`,
        });
        return;
      }
    }

    // Validate total batch size
    const totalSize = files.reduce((sum, file) => sum + file.size, 0);
    if (totalSize > MAX_BATCH_SIZE) {
      const totalMB = (totalSize / (1024 * 1024)).toFixed(1);
      toast.error("Batch too large", {
        description: `Total size (${totalMB}MB) exceeds 5MB limit. Upload fewer files at once.`,
      });
      return;
    }

    // Validate pre-upload mode requirements BEFORE entering tracked upload state
    // This avoids incrementing counter and setting uploading=true for invalid operations
    if (!characterId && !onPreUploadedFilesAdd) {
      toast.error("Cannot upload files", {
        description: "File tracking is not configured for this view",
      });
      return;
    }

    activeUploadsRef.current++;
    setUploading(true);
    setSelectedFiles(files);

    try {
      const formData = new FormData();

      // Pre-upload mode: upload to blob storage only (no characterId yet)
      if (!characterId) {
        for (const file of files) {
          formData.append("files", file, file.name);
        }

        const response = await fetch("/api/v1/knowledge/pre-upload", {
          method: "POST",
          credentials: "include",
          body: formData,
        });

        if (response.ok) {
          const data = await response.json();
          const newFiles = data.files as PreUploadedFile[];

          // Use add callback - parent uses functional update to avoid stale closure issues
          // Non-null assertion safe: validated before entering upload state
          onPreUploadedFilesAdd!(newFiles);

          toast.success("Files uploaded successfully", {
            description: `${data.successCount} file(s) uploaded. They will be processed when you save the character.`,
          });
          setSelectedFiles([]);
          const fileInput = document.getElementById("uploads-tab-file-input") as HTMLInputElement;
          if (fileInput) fileInput.value = "";
        } else {
          const data = await response.json().catch(() => ({}));
          toast.error("Upload failed", {
            description: data.error || "Failed to upload files",
          });
          setSelectedFiles([]);
        }
        return;
      }

      // Normal mode: process files through knowledge service
      formData.append("characterId", characterId);
      for (const file of files) {
        formData.append("files", file, file.name);
      }

      const response = await fetch("/api/v1/knowledge/upload-file", {
        method: "POST",
        credentials: "include",
        body: formData,
      });

      if (response.ok) {
        const data = await response.json();
        toast.success("Files uploaded successfully", {
          description: `${data.successCount} file(s) processed and ready to use`,
        });
        fetchDocuments();

        setSelectedFiles([]);
        const fileInput = document.getElementById("uploads-tab-file-input") as HTMLInputElement;
        if (fileInput) fileInput.value = "";
      } else {
        const data = await response.json().catch(() => ({}));
        toast.error("Upload failed", {
          description: data.error || "Failed to upload files",
        });
        setSelectedFiles([]);
      }
    } finally {
      activeUploadsRef.current--;
      // Only set uploading to false when all concurrent uploads have completed
      if (activeUploadsRef.current === 0) {
        setUploading(false);
      }
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0 && !uploading) {
      handleUpload(files);
    }
  };

  const handleDelete = async (documentId: string) => {
    if (!characterId) return;

    const url = new URL(`/api/v1/knowledge/${documentId}`, window.location.origin);
    url.searchParams.set("characterId", characterId);

    const response = await fetch(url.toString(), {
      method: "DELETE",
      credentials: "include",
    });
    if (response.ok) {
      toast.success("Document deleted");
      fetchDocuments();
    } else {
      toast.error("Failed to delete document");
    }
  };

  const handleDeletePreUpload = async (fileId: string) => {
    const fileToDelete = preUploadedFiles.find((f) => f.id === fileId);
    if (!fileToDelete) return;

    // Fail fast if callbacks aren't provided - deletion would work but UI state wouldn't update
    if (!onPreUploadedFileRemove || !onPreUploadedFilesAdd) {
      toast.error("Cannot delete file", {
        description: "File tracking is not configured for this view",
      });
      return;
    }

    // Optimistically update UI - parent uses functional update to avoid stale closure issues
    onPreUploadedFileRemove(fileId);

    // Delete blob from storage
    try {
      const response = await fetch("/api/v1/knowledge/pre-upload", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ blobUrl: fileToDelete.blobUrl }),
      });

      if (!response.ok) {
        // Restore the file since deletion failed
        onPreUploadedFilesAdd([fileToDelete]);
        toast.error("Failed to delete file");
        return;
      }

      toast.success("File removed");
    } catch {
      // Restore the file on network error
      onPreUploadedFilesAdd([fileToDelete]);
      toast.error("Failed to delete file");
    }
  };

  const getDocumentName = (doc: KnowledgeDocument): string => {
    return (
      doc.metadata?.fileName || doc.metadata?.originalFilename || `Document ${doc.id.slice(0, 8)}`
    );
  };

  const getDocumentAge = (doc: KnowledgeDocument): string => {
    const timestamp = doc.metadata?.uploadedAt || doc.createdAt;
    return formatDistanceToNow(new Date(timestamp), { addSuffix: true });
  };

  // Show pre-upload mode when no characterId
  const isPreUploadMode = !characterId;
  const displayFiles = isPreUploadMode ? preUploadedFiles : documents;
  const displayCount = displayFiles.length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <p className="text-sm text-white/70">
        Upload documents to give your agent context and information.
      </p>

      {/* Upload Section */}
      <div>
        <div
          onDragOver={handleDragOver}
          onDrop={handleDrop}
          className="group relative border-2 border-dashed border-white/20 rounded-xl bg-white/5 hover:border-[#FF5800]/50 transition-all"
        >
          <Input
            id="uploads-tab-file-input"
            type="file"
            multiple
            accept=".pdf,.txt,.md,.doc,.docx,.json,.xml,.yaml,.yml,.csv"
            onChange={(e) => {
              const files = e.target.files;
              if (files && files.length > 0) {
                handleUpload(Array.from(files));
              }
            }}
            disabled={uploading}
            className="hidden"
          />
          <div
            onClick={() => {
              if (!uploading) {
                document.getElementById("uploads-tab-file-input")?.click();
              }
            }}
            className={`p-8 text-center cursor-pointer min-h-[140px] flex items-center justify-center ${uploading ? "opacity-50" : ""}`}
          >
            {uploading ? (
              <div className="flex flex-col items-center gap-3">
                <div className="p-3 rounded-xl bg-[#FF5800]/20">
                  <Loader2 className="h-6 w-6 animate-spin text-[#FF5800]" />
                </div>
                <div>
                  <p className="text-sm text-white/80 font-medium mb-1">Uploading files...</p>
                  <p className="text-xs text-white/50">Please wait</p>
                </div>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-3">
                <div className="p-3 rounded-xl bg-white/5 group-hover:bg-[#FF5800]/20 transition-colors">
                  <Upload className="h-6 w-6 text-neutral-500 group-hover:text-[#FF5800] transition-colors" />
                </div>
                <div>
                  <p className="text-sm text-white/80 font-medium mb-1">
                    Drop files here or browse
                  </p>
                  <p className="text-xs text-white/50">
                    PDF, TXT, MD, DOC, DOCX, JSON, XML, YAML, CSV
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Documents List */}
      <div className="pt-6">
        {(displayCount > 0 || !isPreUploadMode) && (
          <div className="flex items-center justify-between mb-4">
            {displayCount > 0 && (
              <span className="text-sm font-medium text-white/70">
                {displayCount} {isPreUploadMode ? "file" : "document"}
                {displayCount !== 1 ? "s" : ""} {isPreUploadMode ? "ready to process" : "uploaded"}
              </span>
            )}
            {!isPreUploadMode && (
              <Button
                variant="ghost"
                size="sm"
                onClick={fetchDocuments}
                disabled={loading}
                className="text-white/50 hover:text-white hover:bg-white/10 rounded-xl ml-auto"
              >
                <RefreshCw className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`} />
                Refresh
              </Button>
            )}
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-white/40" />
          </div>
        ) : displayCount === 0 ? (
          <div className="text-center py-8">
            <FileText className="h-10 w-10 text-neutral-600 mx-auto mb-2" />
            <p className="text-neutral-500 text-sm">No files uploaded yet</p>
          </div>
        ) : (
          <div className="space-y-2">
            {isPreUploadMode
              ? preUploadedFiles.map((file) => (
                  <div
                    key={file.id}
                    className="flex items-center justify-between p-4 bg-white/5 border border-white/10 rounded-xl group hover:border-white/20 transition-colors"
                  >
                    <div className="flex items-center gap-4 min-w-0">
                      <div className="p-2 bg-white/10 rounded-xl">
                        <FileText className="h-5 w-5 text-white/50" />
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-white/90 truncate">
                          {file.filename}
                        </p>
                        <p className="text-xs text-white/50">
                          {formatDistanceToNow(new Date(file.uploadedAt), {
                            addSuffix: true,
                          })}
                        </p>
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleDeletePreUpload(file.id)}
                      className="text-white/40 hover:text-red-400 hover:bg-red-400/10 rounded-xl transition-all"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))
              : documents.map((doc) => (
                  <div
                    key={doc.id}
                    className="flex items-center justify-between p-4 bg-white/5 border border-white/10 rounded-xl group hover:border-white/20 transition-colors"
                  >
                    <div className="flex items-center gap-4 min-w-0">
                      <div className="p-2 bg-white/10 rounded-xl">
                        <FileText className="h-5 w-5 text-white/50" />
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-white/90 truncate">
                          {getDocumentName(doc)}
                        </p>
                        <p className="text-xs text-white/50">{getDocumentAge(doc)}</p>
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleDelete(doc.id)}
                      className="text-white/40 hover:text-red-400 hover:bg-red-400/10 rounded-xl transition-all"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
          </div>
        )}
      </div>
    </div>
  );
}
