/**
 * Document upload component for knowledge base.
 * Supports file upload and text input with MIME type detection and character association.
 *
 * @param props - Document upload configuration
 * @param props.onUploadSuccess - Callback when upload succeeds
 * @param props.characterId - Optional character ID to associate document with
 */

"use client";

import {
  Alert,
  AlertDescription,
  Button,
  Input,
  Label,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
} from "@elizaos/cloud-ui";
import { CheckCircle2, FileText, Loader2, Upload } from "lucide-react";
import { useState } from "react";

interface DocumentUploadProps {
  onUploadSuccess: () => void;
  characterId: string | null;
}

// Helper function to get the correct MIME type based on file extension.
const getCorrectMimeType = (file: File): string => {
  const filename = file.name.toLowerCase();
  const ext = filename.split(".").pop() || "";

  const mimeTypeMap: Record<string, string> = {
    // Text files
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
    // Documents
    pdf: "application/pdf",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    // Code files - all map to text/plain
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

export function DocumentUpload({ onUploadSuccess, characterId }: DocumentUploadProps) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // File upload state
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);

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
      handleFileUpload(files);
    }
  };

  // Text upload state
  const [textContent, setTextContent] = useState("");
  const [filename, setFilename] = useState("");

  const handleFileUpload = async (files: File[]) => {
    if (files.length === 0) {
      setError("Please select at least one file");
      return;
    }

    setUploading(true);
    setError(null);
    setSuccess(null);
    setSelectedFiles(files);

    const formData = new FormData();

    // Append characterId if provided
    if (characterId) {
      formData.append("characterId", characterId);
    }

    // Append files with corrected MIME types (matching plugin pattern)
    for (const file of files) {
      const correctedMimeType = getCorrectMimeType(file);
      const blob = new Blob([file], { type: correctedMimeType });
      formData.append("files", blob, file.name);
    }

    const response = await fetch("/api/v1/knowledge/upload-file", {
      method: "POST",
      body: formData,
    });

    if (!response.ok) {
      const data = await response.json();
      setUploading(false);
      throw new Error(data.error || "Failed to upload files");
    }

    const data = await response.json();
    setSuccess(data.message || `Successfully uploaded ${files.length} file(s)`);
    setSelectedFiles([]);

    // Reset file input
    const fileInput = document.getElementById("file-input") as HTMLInputElement;
    if (fileInput) {
      fileInput.value = "";
    }

    // Notify parent
    onUploadSuccess();
    setUploading(false);
  };

  const handleTextUpload = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!textContent.trim()) {
      setError("Please enter some text content");
      return;
    }

    setUploading(true);
    setError(null);
    setSuccess(null);

    const response = await fetch("/api/v1/knowledge", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        content: textContent,
        contentType: "text/plain",
        filename: filename || "text-document.txt",
        characterId: characterId || undefined,
      }),
    });

    if (!response.ok) {
      const data = await response.json();
      setUploading(false);
      throw new Error(data.error || "Failed to upload text");
    }

    const data = await response.json();
    setSuccess(data.message);
    setTextContent("");
    setFilename("");

    // Notify parent
    onUploadSuccess();
    setUploading(false);
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
          <AlertDescription className="text-green-600">{success}</AlertDescription>
        </Alert>
      )}

      <Tabs id="document-upload-tabs" defaultValue="file" className="w-full">
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="file">Upload File</TabsTrigger>
          <TabsTrigger value="text">Paste Text</TabsTrigger>
        </TabsList>

        <TabsContent value="file" className="space-y-4">
          <div className="space-y-4">
            <div
              onDragOver={handleDragOver}
              onDrop={handleDrop}
              className="relative border-2 border-dashed border-border rounded-lg hover:border-primary/50 transition-colors"
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
                    handleFileUpload(Array.from(files));
                  }
                }}
                disabled={uploading}
                className="hidden"
              />
              <div
                onClick={() => {
                  if (!uploading) {
                    document.getElementById("file-input")?.click();
                  }
                }}
                className={`p-8 text-center cursor-pointer ${uploading ? "opacity-50" : ""}`}
              >
                {uploading ? (
                  <div className="flex flex-col items-center gap-3">
                    <Loader2 className="h-8 w-8 animate-spin text-primary" />
                    <p className="text-sm text-foreground font-medium">Uploading files...</p>
                  </div>
                ) : (
                  <div className="flex flex-col items-center gap-3">
                    <div className="p-3 rounded-full bg-muted">
                      <Upload className="h-6 w-6 text-muted-foreground" />
                    </div>
                    <div>
                      <p className="text-sm text-foreground font-medium mb-1">
                        Drop files here or <span className="text-primary">browse</span>
                      </p>
                      <p className="text-xs text-muted-foreground">
                        PDF, TXT, MD, DOC, DOCX, JSON, and code files
                      </p>
                    </div>
                  </div>
                )}
              </div>
            </div>

            <p className="text-xs text-muted-foreground text-center">
              Files upload automatically after selection
            </p>

            {selectedFiles.length > 0 && (
              <div className="space-y-2">
                <p className="text-sm font-medium">Uploading {selectedFiles.length} file(s)...</p>
                {selectedFiles.map((file, index) => (
                  <div key={index} className="flex items-center gap-2 p-3 bg-muted rounded-lg">
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
              <Label htmlFor="filename">Document Name (Optional)</Label>
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
              <Label htmlFor="text-content">Content</Label>
              <Textarea
                id="text-content"
                placeholder="Paste your text content here..."
                value={textContent}
                onChange={(e) => setTextContent(e.target.value)}
                disabled={uploading}
                rows={10}
                className="font-mono text-sm"
              />
            </div>

            <Button type="submit" disabled={!textContent.trim() || uploading}>
              {uploading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Processing...
                </>
              ) : (
                <>
                  <Upload className="mr-2 h-4 w-4" />
                  Upload Text
                </>
              )}
            </Button>
          </form>
        </TabsContent>
      </Tabs>
    </div>
  );
}
