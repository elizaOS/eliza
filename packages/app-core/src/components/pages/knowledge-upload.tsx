/**
 * Knowledge upload zone — file picker, drag-and-drop, URL import.
 *
 * Extracted from KnowledgeView.tsx to keep individual files under ~500 LOC.
 */

import { useApp } from "@elizaos/app-core/state";
import { Button, Checkbox, Input, PagePanel } from "@elizaos/app-core";
import { useCallback, useRef, useState } from "react";

export const MAX_UPLOAD_REQUEST_BYTES = 32 * 1_048_576; // Must match server knowledge route limit
export const BULK_UPLOAD_TARGET_BYTES = 24 * 1_048_576;
export const MAX_BULK_REQUEST_DOCUMENTS = 100;
export const LARGE_FILE_WARNING_BYTES = 8 * 1_048_576;
export const SUPPORTED_UPLOAD_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".mdx",
  ".pdf",
  ".docx",
  ".json",
  ".csv",
  ".xml",
  ".html",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
]);

export type KnowledgeUploadFile = File & {
  webkitRelativePath?: string;
};

export type KnowledgeUploadOptions = {
  includeImageDescriptions: boolean;
};

export function getKnowledgeUploadFilename(file: KnowledgeUploadFile): string {
  return file.webkitRelativePath?.trim() || file.name;
}

export function shouldReadKnowledgeFileAsText(
  file: Pick<File, "type" | "name">,
): boolean {
  const textTypes = [
    "text/plain",
    "text/markdown",
    "text/html",
    "text/csv",
    "application/json",
    "application/xml",
  ];

  return (
    textTypes.some((t) => file.type.includes(t)) ||
    file.name.endsWith(".md") ||
    file.name.endsWith(".mdx")
  );
}

export function isSupportedKnowledgeFile(file: Pick<File, "name">): boolean {
  const lowerName = file.name.toLowerCase();
  for (const extension of SUPPORTED_UPLOAD_EXTENSIONS) {
    if (lowerName.endsWith(extension)) return true;
  }
  return false;
}

/* ── Upload Zone ────────────────────────────────────────────────────── */

export function UploadZone({
  onFilesUpload,
  onUrlUpload,
  uploading,
  uploadStatus,
}: {
  onFilesUpload: (
    files: KnowledgeUploadFile[],
    options: KnowledgeUploadOptions,
  ) => void;
  onUrlUpload: (url: string, options: KnowledgeUploadOptions) => void;
  uploading: boolean;
  uploadStatus: { current: number; total: number; filename: string } | null;
}) {
  const { t } = useApp();
  const [dragOver, setDragOver] = useState(false);
  const [urlInput, setUrlInput] = useState("");
  const [showUrlInput, setShowUrlInput] = useState(false);
  const [includeImageDescriptions, setIncludeImageDescriptions] =
    useState(true);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const files = Array.from(e.dataTransfer.files) as KnowledgeUploadFile[];
      if (files.length > 0 && !uploading) {
        onFilesUpload(files, { includeImageDescriptions });
      }
    },
    [includeImageDescriptions, onFilesUpload, uploading],
  );

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (files && files.length > 0 && !uploading) {
        onFilesUpload(Array.from(files) as KnowledgeUploadFile[], {
          includeImageDescriptions,
        });
      }
      e.target.value = "";
    },
    [includeImageDescriptions, onFilesUpload, uploading],
  );

  const handleUrlSubmit = useCallback(() => {
    const url = urlInput.trim();
    if (url && !uploading) {
      onUrlUpload(url, { includeImageDescriptions });
      setUrlInput("");
      setShowUrlInput(false);
    }
  }, [includeImageDescriptions, urlInput, uploading, onUrlUpload]);

  return (
    <fieldset
      className="w-full"
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
      aria-label={t("aria.knowledgeUpload")}
    >
      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        multiple
        accept=".txt,.md,.mdx,.pdf,.docx,.json,.csv,.xml,.html,.png,.jpg,.jpeg,.webp,.gif"
        onChange={handleFileSelect}
      />
      <div className="flex items-start justify-between gap-3 px-1">
        <PagePanel.Meta compact tone="strong">
          {t("knowledgeview.FormatsCount", {
            defaultValue: "{{count}} formats",
            count: SUPPORTED_UPLOAD_EXTENSIONS.size,
          })}
        </PagePanel.Meta>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <Button
          variant="default"
          size="sm"
          className="h-10 px-4 text-xs-tight font-semibold text-txt-strong shadow-sm hover:text-txt-strong"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
        >
          {t("knowledgeview.ChooseFiles")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-10 px-4 text-xs-tight font-semibold text-txt shadow-sm hover:text-txt"
          onClick={() => setShowUrlInput(!showUrlInput)}
          disabled={uploading}
        >
          {t("knowledgeview.AddFromURL")}
        </Button>
      </div>
      <div className="mt-2 inline-flex min-h-11 w-full items-center gap-2 rounded-xl border border-border/35 bg-bg/18 px-3 text-xs-tight leading-relaxed text-muted-strong transition-colors hover:border-border/55 hover:bg-bg/28 hover:text-txt">
        <Checkbox
          id="knowledge-upload-image-descriptions"
          checked={includeImageDescriptions}
          onCheckedChange={(checked) => setIncludeImageDescriptions(!!checked)}
          disabled={uploading}
        />
        <label
          htmlFor="knowledge-upload-image-descriptions"
          className="min-w-0 cursor-pointer"
        >
          {t("knowledgeview.IncludeAIImageDes")}
        </label>
      </div>
      <div
        className={`mt-3 rounded-2xl border px-3 py-3 transition-colors ${
          dragOver
            ? "border-accent/50 bg-accent/8 shadow-sm"
            : "border-dashed border-border/35 bg-card/62"
        } ${uploading ? "opacity-60" : ""}`}
      >
        {(dragOver || uploading) && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs-tight text-muted/80">
            <span className="font-medium text-txt/80">
              {uploadStatus
                ? t("knowledgeview.UploadingProgress", {
                    defaultValue: "Uploading {{current}}/{{total}}{{filename}}",
                    current: uploadStatus.current,
                    total: uploadStatus.total,
                    filename: uploadStatus.filename
                      ? `: ${uploadStatus.filename}`
                      : "",
                  })
                : t("knowledgeview.DropFilesOrFoldersToUpload", {
                    defaultValue: "Drop files or folders to upload",
                  })}
            </span>
          </div>
        )}

        {!dragOver && !uploading && !showUrlInput && (
          <div className="space-y-1 py-1 text-center">
            <div className="text-xs-tight font-medium text-muted-strong">
              {t("knowledgeview.DropFilesHereToUpload", {
                defaultValue: "Drop files here to upload",
              })}
            </div>
            <div className="text-2xs text-muted">
              {t("knowledgeview.UploadSupportedTypes", {
                defaultValue: "Docs, PDFs, JSON, CSV, and supported images.",
              })}
            </div>
          </div>
        )}

        {showUrlInput && (
          <div
            className={`${dragOver || uploading ? "mt-2" : ""} animate-in fade-in slide-in-from-top-2 duration-300`}
          >
            <div className="mb-2 text-xs-tight font-medium leading-relaxed text-muted">
              {t("knowledgeview.PasteAURLToImpor")}
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                type="url"
                placeholder={t("knowledgeview.httpsExampleCom")}
                value={urlInput}
                onChange={(e) => setUrlInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleUrlSubmit()}
                disabled={uploading}
                className="h-10 flex-1 border-border/55 bg-bg/72 text-xs shadow-none"
              />
              <Button
                variant="default"
                size="sm"
                className="h-10 px-4 text-xs-tight font-semibold"
                onClick={handleUrlSubmit}
                disabled={!urlInput.trim() || uploading}
              >
                {t("settings.import")}
              </Button>
            </div>
          </div>
        )}
      </div>
    </fieldset>
  );
}
