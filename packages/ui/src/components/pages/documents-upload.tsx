import { Button, Checkbox, Input, Textarea } from "@elizaos/ui";
import {
  Bot,
  FileUp,
  Globe2,
  Link2,
  type LucideIcon,
  NotebookPen,
  Shield,
  User,
} from "lucide-react";
import {
  type ChangeEvent,
  type DragEvent,
  useCallback,
  useMemo,
  useRef,
  useState,
} from "react";
import type { DocumentScope } from "../../api/client-types-chat";
import { useApp } from "../../state/useApp";

export const MAX_UPLOAD_REQUEST_BYTES = 32 * 1_048_576;
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
export const DOCUMENT_UPLOAD_ACCEPT = Array.from(
  SUPPORTED_UPLOAD_EXTENSIONS,
).join(",");

export type DocumentUploadFile = File & {
  webkitRelativePath?: string;
};

export type DocumentUploadOptions = {
  includeImageDescriptions: boolean;
  scope: DocumentScope;
};

export const DEFAULT_DOCUMENT_UPLOAD_SCOPE: DocumentScope = "user-private";

const DOCUMENT_UPLOAD_SCOPE_OPTIONS: ReadonlyArray<{
  value: DocumentScope;
  labelKey: string;
  defaultLabel: string;
  titleKey: string;
  defaultTitle: string;
  Icon: LucideIcon;
}> = [
  {
    value: "user-private",
    labelKey: "documentsview.ScopeUser",
    defaultLabel: "User",
    titleKey: "documentsview.ScopeUserDescription",
    defaultTitle: "Visible to this user and the owner.",
    Icon: User,
  },
  {
    value: "global",
    labelKey: "documentsview.ScopeGlobal",
    defaultLabel: "Global",
    titleKey: "documentsview.ScopeGlobalDescription",
    defaultTitle: "Visible to everyone who can use this agent.",
    Icon: Globe2,
  },
  {
    value: "owner-private",
    labelKey: "documentsview.ScopeOwner",
    defaultLabel: "Owner",
    titleKey: "documentsview.ScopeOwnerDescription",
    defaultTitle: "Owner-only document.",
    Icon: Shield,
  },
  {
    value: "agent-private",
    labelKey: "documentsview.ScopeAgent",
    defaultLabel: "Agent",
    titleKey: "documentsview.ScopeAgentDescription",
    defaultTitle: "Private to the agent runtime.",
    Icon: Bot,
  },
];

export function getDocumentUploadFilename(file: DocumentUploadFile): string {
  return file.webkitRelativePath?.trim() || file.name;
}

export function shouldReadDocumentFileAsText(
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

export function isSupportedDocumentFile(file: Pick<File, "name">): boolean {
  const lowerName = file.name.toLowerCase();
  for (const extension of SUPPORTED_UPLOAD_EXTENSIONS) {
    if (lowerName.endsWith(extension)) return true;
  }
  return false;
}

/* -- Upload Zone ---------------------------------------------------------- */

export function UploadZone({
  fileInputId,
  onFilesUpload,
  onTextUpload,
  onUrlUpload,
  uploading,
  uploadStatus,
}: {
  fileInputId?: string;
  onFilesUpload: (
    files: DocumentUploadFile[],
    options: DocumentUploadOptions,
  ) => void;
  onTextUpload: (
    text: string,
    title: string | undefined,
    options: DocumentUploadOptions,
  ) => void;
  onUrlUpload: (url: string, options: DocumentUploadOptions) => void;
  uploading: boolean;
  uploadStatus: { current: number; total: number; filename: string } | null;
}) {
  const { t } = useApp();
  const [dragOver, setDragOver] = useState(false);
  const [urlInput, setUrlInput] = useState("");
  const [textInput, setTextInput] = useState("");
  const [titleInput, setTitleInput] = useState("");
  const [showUrlInput, setShowUrlInput] = useState(false);
  const [showTextInput, setShowTextInput] = useState(false);
  const [includeImageDescriptions, setIncludeImageDescriptions] =
    useState(true);
  const [selectedScope, setSelectedScope] = useState<DocumentScope>(
    DEFAULT_DOCUMENT_UPLOAD_SCOPE,
  );
  const fileInputRef = useRef<HTMLInputElement>(null);

  const uploadOptions = useMemo<DocumentUploadOptions>(
    () => ({
      includeImageDescriptions,
      scope: selectedScope,
    }),
    [includeImageDescriptions, selectedScope],
  );

  const handleDrop = useCallback(
    (event: DragEvent<HTMLFieldSetElement>) => {
      event.preventDefault();
      setDragOver(false);
      const files = Array.from(
        event.dataTransfer.files,
      ) as DocumentUploadFile[];
      if (files.length > 0 && !uploading) {
        onFilesUpload(files, uploadOptions);
      }
    },
    [onFilesUpload, uploadOptions, uploading],
  );

  const handleFileSelect = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const files = event.target.files;
      if (files && files.length > 0 && !uploading) {
        onFilesUpload(Array.from(files) as DocumentUploadFile[], uploadOptions);
      }
      event.target.value = "";
    },
    [onFilesUpload, uploadOptions, uploading],
  );

  const handleUrlSubmit = useCallback(() => {
    const url = urlInput.trim();
    if (url && !uploading) {
      onUrlUpload(url, uploadOptions);
      setUrlInput("");
      setShowUrlInput(false);
    }
  }, [onUrlUpload, uploadOptions, uploading, urlInput]);

  const handleTextSubmit = useCallback(() => {
    const text = textInput.trim();
    if (text && !uploading) {
      onTextUpload(text, titleInput.trim() || undefined, uploadOptions);
      setTextInput("");
      setTitleInput("");
      setShowTextInput(false);
    }
  }, [onTextUpload, textInput, titleInput, uploadOptions, uploading]);

  return (
    <fieldset
      className="w-full"
      onDragOver={(event) => {
        event.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
      aria-label={t("aria.documentsUpload")}
    >
      <input
        id={fileInputId}
        ref={fileInputRef}
        type="file"
        className="hidden"
        multiple
        accept={DOCUMENT_UPLOAD_ACCEPT}
        onChange={handleFileSelect}
      />
      <div
        className={`rounded-xl border px-3 py-3 transition-colors ${
          dragOver
            ? "border-accent/45 bg-accent/8 shadow-sm"
            : "border-border/35 bg-card/62"
        } ${uploading ? "opacity-60" : ""}`}
      >
        <div className="flex items-center gap-2">
          <div className="flex shrink-0 items-center gap-1.5">
            <Button
              variant="outline"
              size="icon"
              className="h-9 w-9 rounded-lg"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              aria-label={t("documentsview.ChooseFiles", {
                defaultValue: "Choose files",
              })}
              title={t("documentsview.ChooseFiles", {
                defaultValue: "Choose files",
              })}
            >
              <FileUp className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              className={`h-9 w-9 rounded-lg ${
                showUrlInput ? "border-accent/45 bg-accent/12 text-txt" : ""
              }`}
              onClick={() => setShowUrlInput((current) => !current)}
              disabled={uploading}
              aria-label={t("documentsview.AddFromURL", {
                defaultValue: "Add from URL",
              })}
              title={t("documentsview.AddFromURL", {
                defaultValue: "Add from URL",
              })}
            >
              <Link2 className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              className={`h-9 w-9 rounded-lg ${
                showTextInput ? "border-accent/45 bg-accent/12 text-txt" : ""
              }`}
              onClick={() => setShowTextInput((current) => !current)}
              disabled={uploading}
              aria-label={t("documentsview.NewTextDocument", {
                defaultValue: "New text document",
              })}
              title={t("documentsview.NewTextDocument", {
                defaultValue: "New text document",
              })}
            >
              <NotebookPen className="h-4 w-4" />
            </Button>
          </div>
          <div className="min-w-0 flex-1 truncate text-xs-tight text-muted-strong">
            {uploadStatus
              ? t("documentsview.UploadingProgress", {
                  defaultValue: "Uploading {{current}}/{{total}}{{filename}}",
                  current: uploadStatus.current,
                  total: uploadStatus.total,
                  filename: uploadStatus.filename
                    ? `: ${uploadStatus.filename}`
                    : "",
                })
              : dragOver
                ? t("documentsview.DropFilesOrFoldersToUpload", {
                    defaultValue: "Drop files or folders to upload",
                  })
                : t("documentsview.DropFilesHereToUpload", {
                    defaultValue: "Drop files here to upload",
                  })}
          </div>
        </div>

        <fieldset className="mt-3 flex min-w-0 flex-wrap items-center gap-1.5 border-0 p-0">
          <legend className="sr-only">
            {t("documentsview.ScopeSelectorLabel", {
              defaultValue: "Document scope",
            })}
          </legend>
          {DOCUMENT_UPLOAD_SCOPE_OPTIONS.map(
            ({
              value,
              labelKey,
              defaultLabel,
              titleKey,
              defaultTitle,
              Icon,
            }) => {
              const active = selectedScope === value;
              return (
                <button
                  key={value}
                  type="button"
                  aria-pressed={active}
                  title={t(titleKey, { defaultValue: defaultTitle })}
                  onClick={() => setSelectedScope(value)}
                  disabled={uploading}
                  className={`inline-flex h-7 items-center gap-1.5 rounded-full border px-2 text-2xs font-semibold transition-colors ${
                    active
                      ? "border-accent/45 bg-accent/12 text-accent-fg"
                      : "border-border/30 bg-bg-muted/20 text-muted hover:border-border/55 hover:text-txt"
                  }`}
                >
                  <Icon className="h-3 w-3" aria-hidden />
                  {t(labelKey, { defaultValue: defaultLabel })}
                </button>
              );
            },
          )}
        </fieldset>

        {showUrlInput && (
          <div className="mt-3 animate-in fade-in slide-in-from-top-2 duration-300">
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                type="url"
                placeholder={t("documentsview.httpsExampleCom")}
                value={urlInput}
                onChange={(event) => setUrlInput(event.target.value)}
                onKeyDown={(event) =>
                  event.key === "Enter" && handleUrlSubmit()
                }
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

        {showTextInput && (
          <div className="mt-3 animate-in fade-in slide-in-from-top-2 duration-300">
            <div className="flex flex-col gap-2">
              <Input
                type="text"
                placeholder={t("documentsview.TitleOptional", {
                  defaultValue: "Title (optional)",
                })}
                value={titleInput}
                onChange={(event) => setTitleInput(event.target.value)}
                disabled={uploading}
                className="h-10 border-border/55 bg-bg/72 text-xs shadow-none"
              />
              <Textarea
                placeholder={t("documentsview.PasteText", {
                  defaultValue: "Paste knowledge text...",
                })}
                value={textInput}
                onChange={(event) => setTextInput(event.target.value)}
                disabled={uploading}
                className="min-h-28 resize-y border-border/55 bg-bg/72 text-xs shadow-none"
              />
              <Button
                variant="default"
                size="sm"
                className="h-10 self-end px-4 text-xs-tight font-semibold"
                onClick={handleTextSubmit}
                disabled={!textInput.trim() || uploading}
              >
                {t("common.save", { defaultValue: "Save" })}
              </Button>
            </div>
          </div>
        )}

        <div className="mt-3 inline-flex min-h-8 w-full items-center gap-2 text-2xs leading-relaxed text-muted">
          <Checkbox
            id="documents-upload-image-descriptions"
            checked={includeImageDescriptions}
            onCheckedChange={(checked: boolean | "indeterminate") =>
              setIncludeImageDescriptions(!!checked)
            }
            disabled={uploading}
          />
          <label
            htmlFor="documents-upload-image-descriptions"
            className="inline-flex min-w-0 cursor-pointer items-center rounded-full border border-border/30 bg-bg-muted/20 px-2 py-0.5"
          >
            {t("documentsview.IncludeAIImageDes")}
          </label>
        </div>
      </div>
    </fieldset>
  );
}
