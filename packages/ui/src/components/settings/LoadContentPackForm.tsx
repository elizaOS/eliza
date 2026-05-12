import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { FolderOpen } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useApp, useContentPack } from "../../state";

export function LoadContentPackForm() {
  const { t } = useApp();
  const {
    activePack,
    error: packLoadError,
    canPickDirectory,
    deactivate,
    loadFromUrl,
    loadFromFiles,
  } = useContentPack();
  const [urlInput, setUrlInput] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!canPickDirectory || !fileInputRef.current) return;
    fileInputRef.current.setAttribute("webkitdirectory", "");
    fileInputRef.current.setAttribute("directory", "");
  }, [canPickDirectory]);

  const handleLoadFromUrl = async () => {
    await loadFromUrl(urlInput);
    setUrlInput("");
  };

  const handleFolderSelected = async (
    e: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const files = Array.from(e.target.files ?? []);
    await loadFromFiles(files);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  return (
    <section className="space-y-2">
      <h3 className="text-xs font-medium uppercase tracking-wider text-muted">
        {t("startupshell.LoadPack", {
          defaultValue: "Load content pack",
        })}
      </h3>
      <div className="flex items-center gap-2">
        <Input
          placeholder={t("settings.appearance.packUrlPlaceholder", {
            defaultValue: "https://example.com/packs/my-pack/",
          })}
          value={urlInput}
          onChange={(e) => setUrlInput(e.target.value)}
          className="h-9 flex-1 rounded-lg bg-bg text-sm"
          onKeyDown={(e) => {
            if (e.key === "Enter") handleLoadFromUrl();
          }}
        />
        <Button
          variant="outline"
          size="sm"
          className="h-9 rounded-lg"
          onClick={handleLoadFromUrl}
          disabled={!urlInput.trim()}
        >
          {t("settings.appearance.load", { defaultValue: "Load" })}
        </Button>
        {canPickDirectory && (
          <>
            <Button
              variant="ghost"
              size="sm"
              className="h-9 rounded-lg text-xs text-muted hover:text-txt"
              onClick={() => fileInputRef.current?.click()}
              title={t("settings.appearance.loadFromFolder", {
                defaultValue: "From folder",
              })}
            >
              <FolderOpen className="h-3.5 w-3.5" aria-hidden />
              {t("settings.appearance.loadFromFolder", {
                defaultValue: "From folder",
              })}
            </Button>
            <input
              type="file"
              ref={fileInputRef}
              multiple
              className="hidden"
              onChange={handleFolderSelected}
            />
          </>
        )}
      </div>
      {packLoadError && (
        <p className="text-xs-tight text-destructive">{packLoadError}</p>
      )}
      {activePack && (
        <Button
          variant="link"
          size="sm"
          className="h-auto p-0 text-xs-tight text-muted hover:text-txt"
          onClick={deactivate}
        >
          {t("settings.appearance.deactivate", {
            defaultValue: "Deactivate current pack",
          })}
        </Button>
      )}
    </section>
  );
}
