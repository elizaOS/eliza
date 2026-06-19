/**
 * Document upload: drag-drop / file-picker upload and a paste-text tab, scoped
 * to the selected character.
 *
 * Ported from `@elizaos/cloud-frontend/src/dashboard/documents/_components/document-upload.tsx`.
 * Raw `fetch()` is replaced by the typed `useUploadFiles` / `useUploadText`
 * mutations (which invalidate the list query on success), and the error path
 * surfaces the structured `ApiError` message instead of re-parsing the body.
 */

import { CheckCircle2, FileText, Loader2, Upload } from "lucide-react";
import { useState } from "react";
import { Alert, AlertDescription } from "../../../components/ui/alert";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { Label } from "../../../components/ui/label";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "../../../components/ui/tabs";
import { Textarea } from "../../../components/ui/textarea";
import { ApiError } from "../../lib/api-client";
import { useCloudT } from "../../shell/CloudI18nProvider";
import { useUploadFiles, useUploadText } from "../lib/documents";

interface DocumentUploadProps {
  onUploadSuccess: () => void;
  characterId: string | null;
}

/** Map a file extension to the MIME type the document plugin expects. */
const getCorrectMimeType = (file: File): string => {
  const ext = file.name.toLowerCase().split(".").pop() || "";
  const mimeTypeMap: Record<string, string> = {
    txt: "text/plain",
    md: "text/markdown",
    markdown: "text/markdown",
    json: "application/json",
    xml: "application/xml",
    html: "text/html",
    htm: "text/html",
    css: "text/css",
    csv: "text/csv",
    yaml: "text/yaml",
    yml: "text/yaml",
    pdf: "application/pdf",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ts: "text/plain",
    tsx: "text/plain",
    js: "text/plain",
    jsx: "text/plain",
    py: "text/plain",
    java: "text/plain",
    c: "text/plain",
    cpp: "text/plain",
    go: "text/plain",
    rs: "text/plain",
  };
  return mimeTypeMap[ext] || file.type || "application/octet-stream";
};

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

export function DocumentUpload({
  onUploadSuccess,
  characterId,
}: DocumentUploadProps) {
  const t = useCloudT();
  const uploadFiles = useUploadFiles(characterId);
  const uploadText = useUploadText(characterId);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [textContent, setTextContent] = useState("");
  const [filename, setFilename] = useState("");

  const uploading = uploadFiles.isPending || uploadText.isPending;

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0 && !uploading) {
      setError(null);
      setSuccess(null);
      void handleFileUpload(files);
    }
  };

  const handleFileUpload = async (files: File[]) => {
    if (files.length === 0) {
      setError(
        t("cloud.documents.upload.selectFile", {
          defaultValue: "Please select at least one file",
        }),
      );
      return;
    }

    setError(null);
    setSuccess(null);
    setSelectedFiles(files);

    try {
      const data = await uploadFiles.mutateAsync({
        files,
        mimeTypes: files.map(getCorrectMimeType),
        characterId,
      });
      setSuccess(
        data.message ||
          t("cloud.documents.upload.successfullyUploaded", {
            defaultValue: "Successfully uploaded {{n}} file(s)",
            n: files.length,
          }),
      );
      setSelectedFiles([]);
      const fileInput = document.getElementById(
        "file-input",
      ) as HTMLInputElement | null;
      if (fileInput) fileInput.value = "";
      onUploadSuccess();
    } catch (err) {
      setSelectedFiles([]);
      setError(
        errorMessage(
          err,
          t("cloud.documents.upload.uploadFailed", {
            defaultValue: "Failed to upload files",
          }),
        ),
      );
    }
  };

  const handleTextUpload = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!textContent.trim()) {
      setError(
        t("cloud.documents.upload.enterContent", {
          defaultValue: "Please enter some text content",
        }),
      );
      return;
    }

    setError(null);
    setSuccess(null);

    try {
      const data = await uploadText.mutateAsync({
        content: textContent,
        filename: filename || "text-document.txt",
        characterId,
      });
      setSuccess(data.message ?? null);
      setTextContent("");
      setFilename("");
      onUploadSuccess();
    } catch (err) {
      setError(
        errorMessage(
          err,
          t("cloud.documents.upload.uploadTextFailed", {
            defaultValue: "Failed to upload text",
          }),
        ),
      );
    }
  };

  return (
    <div className="space-y-6">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {success && (
        <Alert className="border-green-500 bg-green-50 dark:bg-green-950">
          <CheckCircle2 className="h-4 w-4 text-green-600" />
          <AlertDescription className="text-green-600">
            {success}
          </AlertDescription>
        </Alert>
      )}

      <Tabs id="document-upload-tabs" defaultValue="file" className="w-full">
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="file">
            {t("cloud.documents.upload.tabFile", {
              defaultValue: "Upload File",
            })}
          </TabsTrigger>
          <TabsTrigger value="text">
            {t("cloud.documents.upload.tabText", {
              defaultValue: "Paste Text",
            })}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="file" className="space-y-4">
          <div className="space-y-4">
            <section
              onDragOver={handleDragOver}
              onDrop={handleDrop}
              aria-label={t("cloud.documents.upload.dropZoneAria", {
                defaultValue: "File upload drop zone",
              })}
              className="relative border-2 border-dashed border-border rounded-sm hover:border-primary/50 transition-colors"
            >
              <Input
                id="file-input"
                type="file"
                multiple
                accept=".pdf,.txt,.md,.doc,.docx,.json,.xml,.yaml,.yml,.csv,.html,.js,.ts,.tsx,.jsx,.py,.java,.c,.cpp,.go,.rs"
                onChange={(e) => {
                  const files = e.target.files;
                  if (files && files.length > 0) {
                    setError(null);
                    setSuccess(null);
                    void handleFileUpload(Array.from(files));
                  }
                }}
                disabled={uploading}
                className="hidden"
              />
              <label
                htmlFor="file-input"
                className={`p-8 text-center cursor-pointer block ${uploading ? "opacity-50" : ""}`}
              >
                {uploadFiles.isPending ? (
                  <div className="flex flex-col items-center gap-3">
                    <Loader2 className="h-8 w-8 animate-spin text-primary" />
                    <p className="text-sm text-foreground font-medium">
                      {t("cloud.documents.upload.uploadingFiles", {
                        defaultValue: "Uploading files...",
                      })}
                    </p>
                  </div>
                ) : (
                  <div className="flex flex-col items-center gap-3">
                    <div className="p-3 rounded-full bg-muted">
                      <Upload className="h-6 w-6 text-muted-foreground" />
                    </div>
                    <div>
                      <p className="text-sm text-foreground font-medium mb-1">
                        {t("cloud.documents.upload.dropOr", {
                          defaultValue: "Drop files here or",
                        })}{" "}
                        <span className="text-primary">
                          {t("cloud.documents.upload.browse", {
                            defaultValue: "browse",
                          })}
                        </span>
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {t("cloud.documents.upload.fileTypes", {
                          defaultValue:
                            "PDF, TXT, MD, DOC, DOCX, JSON, and code files",
                        })}
                      </p>
                    </div>
                  </div>
                )}
              </label>
            </section>

            {selectedFiles.length > 0 && (
              <div className="space-y-2">
                <p className="text-sm font-medium">
                  {t("cloud.documents.upload.uploadingNFiles", {
                    defaultValue: "Uploading {{n}} file(s)...",
                    n: selectedFiles.length,
                  })}
                </p>
                {selectedFiles.map((file) => (
                  <div
                    key={file.name}
                    className="flex items-center gap-2 p-3 bg-muted rounded-sm"
                  >
                    <FileText className="h-5 w-5 text-muted-foreground" />
                    <div className="flex-1">
                      <p className="text-sm font-medium">{file.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {(file.size / 1024).toFixed(2)} KB
                      </p>
                    </div>
                    <Loader2 className="h-4 w-4 animate-spin text-primary" />
                  </div>
                ))}
              </div>
            )}
          </div>
        </TabsContent>

        <TabsContent value="text" className="space-y-4">
          <form onSubmit={handleTextUpload} className="space-y-4">
            <div>
              <Label htmlFor="filename">
                {t("cloud.documents.upload.docNameLabel", {
                  defaultValue: "Document Name (Optional)",
                })}
              </Label>
              <Input
                id="filename"
                type="text"
                placeholder="my-document.txt"
                value={filename}
                onChange={(e) => setFilename(e.target.value)}
                disabled={uploading}
              />
            </div>

            <div>
              <Label htmlFor="text-content">
                {t("cloud.documents.upload.contentLabel", {
                  defaultValue: "Content",
                })}
              </Label>
              <Textarea
                id="text-content"
                placeholder={t("cloud.documents.upload.contentPlaceholder", {
                  defaultValue: "Paste your text content here...",
                })}
                value={textContent}
                onChange={(e) => setTextContent(e.target.value)}
                disabled={uploading}
                rows={10}
                className="font-mono text-sm"
              />
            </div>

            <Button type="submit" disabled={!textContent.trim() || uploading}>
              {uploadText.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {t("cloud.documents.upload.processing", {
                    defaultValue: "Processing...",
                  })}
                </>
              ) : (
                <>
                  <Upload className="mr-2 h-4 w-4" />
                  {t("cloud.documents.upload.uploadText", {
                    defaultValue: "Upload Text",
                  })}
                </>
              )}
            </Button>
          </form>
        </TabsContent>
      </Tabs>
    </div>
  );
}
