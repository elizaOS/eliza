import { Button, Checkbox, Input } from "@elizaos/ui";

import { useCallback, useRef, useState } from "react";
import { useApp } from "../../state/useApp";

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
export const KNOWLEDGE_UPLOAD_ACCEPT = Array.from(
  SUPPORTED_UPLOAD_EXTENSIONS,
).join(",");

export type KnowledgeUploadFile = File & {
  webkitRelativePath?: string;
};

export type KnowledgeUploadOptions = {
  includeImageDescriptions: boolean;
};

const svgBase = {
  xmlns: "http://www.w3.org/2000/svg",
  width: 24,
  height: 24,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

const UploadIcon = ({ className }: { className?: string }) => (
  <svg {...svgBase} className={className} aria-hidden="true">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" />
  </svg>
);

const LinkIcon = ({ className }: { className?: string }) => (
  <svg {...svgBase} className={className} aria-hidden="true">
    <path d="M10 13a5 5 0 0 0 7.07 0l2.83-2.83a5 5 0 0 0-7.07-7.07L11 4" />
    <path d="M14 11a5 5 0 0 0-7.07 0L4.1 13.83a5 5 0 1 0 7.07 7.07L13 20" />
  </svg>
);

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
  fileInputId,
  onFilesUpload,
  onUrlUpload,
  uploading,
  uploadStatus,
}: {
  fileInputId?: string;
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
        id={fileInputId}
        ref={fileInputRef}
        type="file"
        className="hidden"
        multiple
        accept={KNOWLEDGE_UPLOAD_ACCEPT}
        onChange={handleFileSelect}
      />
      <div
        className={`rounded-2xl border px-3 py-3 transition-colors ${
          dragOver
            ? "border-accent/45 bg-accent/8 shadow-sm"
            : "border-border/35 bg-card/62"
        } ${uploading ? "opacity-60" : ""}`}
      >
        <div className="flex items-center gap-2">
          <div className="flex shrink-0 items-center gap-2">
            <Button
              variant="outline"
              size="icon"
              className="h-9 w-9 rounded-xl"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              aria-label={t("knowledgeview.ChooseFiles", {
                defaultValue: "Choose files",
              })}
              title={t("knowledgeview.ChooseFiles", {
                defaultValue: "Choose files",
              })}
            >
              <UploadIcon className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              className={`h-9 w-9 rounded-xl ${showUrlInput ? "border-accent/45 bg-accent/12 text-txt" : ""}`}
              onClick={() => setShowUrlInput((current) => !current)}
              disabled={uploading}
              aria-label={t("knowledgeview.AddFromURL", {
                defaultValue: "Add from URL",
              })}
              title={t("knowledgeview.AddFromURL", {
                defaultValue: "Add from URL",
              })}
            >
              <LinkIcon className="h-4 w-4" />
            </Button>
          </div>
          <div className="min-w-0 flex-1 text-xs-tight text-muted-strong">
            {uploadStatus
              ? t("knowledgeview.UploadingProgress", {
                  defaultValue: "Uploading {{current}}/{{total}}{{filename}}",
                  current: uploadStatus.current,
                  total: uploadStatus.total,
                  filename: uploadStatus.filename
                    ? `: ${uploadStatus.filename}`
                    : "",
                })
              : dragOver
                ? t("knowledgeview.DropFilesOrFoldersToUpload", {
                    defaultValue: "Drop files or folders to upload",
                  })
                : t("knowledgeview.DropFilesHereToUpload", {
                    defaultValue: "Drop files here to upload",
                  })}
          </div>
        </div>

        {showUrlInput && (
          <div className="mt-3 animate-in fade-in slide-in-from-top-2 duration-300">
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

        <div className="mt-3 inline-flex min-h-9 w-full items-center gap-2 text-2xs leading-relaxed text-muted">
          <Checkbox
            id="knowledge-upload-image-descriptions"
            checked={includeImageDescriptions}
            onCheckedChange={(checked: boolean | "indeterminate") =>
              setIncludeImageDescriptions(!!checked)
            }
            disabled={uploading}
          />
          <label
            htmlFor="knowledge-upload-image-descriptions"
            className="min-w-0 cursor-pointer"
          >
            {t("knowledgeview.IncludeAIImageDes")}
          </label>
        </div>
      </div>
    </fieldset>
  );
}
