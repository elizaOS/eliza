import { Button } from "@elizaos/ui";
import type { RegistryAppInfo } from "../../api";
import { useApp } from "../../state";
import { getAppDetailExtension } from "./extensions/registry";
import { CATEGORY_LABELS, getAppEmoji } from "./helpers";

interface AppDetailPaneProps {
  app: RegistryAppInfo;
  busy: boolean;
  compact?: boolean;
  hasActiveViewer: boolean;
  isActive: boolean;
  onBack: () => void;
  onLaunch: () => void;
  onOpenCurrentGame: () => void;
  onOpenCurrentGameInNewTab: () => void;
}

export function AppDetailPane({
  app,
  busy,
  compact = false,
  hasActiveViewer,
  isActive,
  onBack,
  onLaunch,
  onOpenCurrentGame,
  onOpenCurrentGameInNewTab,
}: AppDetailPaneProps) {
  const { t } = useApp();
  const DetailExtension = getAppDetailExtension(app);

  if (compact) {
    return (
      <div className="phone-inline-detail">
        <button
          type="button"
          className="flex items-center gap-1.5 text-[12px] text-muted hover:text-txt mb-4 cursor-pointer"
          onClick={onBack}
        >
          ← {t("appsview.Back")}
        </button>
        <div className="flex items-center gap-3 mb-4">
          <div className="phone-app-icon-lg">{getAppEmoji(app)}</div>
          <div className="flex-1 min-w-0">
            <div className="font-bold text-sm text-txt truncate">
              {app.displayName ?? app.name}
            </div>
            <div className="flex items-center gap-2 mt-0.5">
              {isActive ? (
                <span className="text-[10px] font-bold text-ok">
                  {t("appsview.Active")}
                </span>
              ) : (
                <span className="text-[10px] text-muted">
                  {t("appsview.Inactive")}
                </span>
              )}
            </div>
          </div>
        </div>
        <div className="text-[12px] text-muted leading-relaxed mb-4">
          {app.description ?? "No description"}
        </div>
        <Button
          variant="default"
          size="sm"
          className="rounded-xl shadow-sm w-full mb-4"
          disabled={busy}
          onClick={onLaunch}
        >
          {busy ? "Launching..." : "Launch"}
        </Button>
        {hasActiveViewer ? (
          <Button
            variant="outline"
            size="sm"
            className="rounded-xl shadow-sm w-full mb-4"
            onClick={onOpenCurrentGame}
          >
            Resume Session
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <>
      <div className="mb-4">
        <Button
          variant="outline"
          size="sm"
          className="rounded-xl shadow-sm"
          onClick={onBack}
        >
          {t("appsview.Back")}
        </Button>
      </div>

      <div className="flex items-center gap-4 mb-5">
        <div className="phone-app-icon-lg">{getAppEmoji(app)}</div>
        <div className="flex-1 min-w-0">
          <div className="font-bold text-lg text-txt">
            {app.displayName ?? app.name}
          </div>
          <div className="flex items-center gap-2 mt-1">
            {isActive ? (
              <span className="text-[10px] font-bold text-ok">
                {t("appsview.Active")}
              </span>
            ) : (
              <span className="text-[10px] text-muted">
                {t("appsview.Inactive")}
              </span>
            )}
            {app.category ? (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full border border-border text-muted">
                {CATEGORY_LABELS[app.category] ?? app.category}
              </span>
            ) : null}
            {app.latestVersion ? (
              <span className="text-[10px] text-muted font-mono">
                v{app.latestVersion}
              </span>
            ) : null}
          </div>
        </div>
      </div>

      <div className="text-[13px] text-muted leading-relaxed mb-5 pb-5 border-b border-border">
        {app.description ?? "No description available."}
      </div>

      <div className="flex flex-wrap gap-2 mb-5">
        <Button
          variant="default"
          size="sm"
          className="rounded-xl shadow-sm px-6"
          disabled={busy}
          onClick={onLaunch}
        >
          {busy ? "Launching..." : "Launch"}
        </Button>
        {hasActiveViewer ? (
          <>
            <Button
              variant="outline"
              size="sm"
              className="rounded-xl shadow-sm"
              onClick={onOpenCurrentGame}
            >
              Resume Session
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="rounded-xl shadow-sm"
              onClick={onOpenCurrentGameInNewTab}
            >
              Open in Tab
            </Button>
          </>
        ) : null}
      </div>

      <div className="flex flex-col gap-3 text-[12px] mb-5">
        <div className="flex justify-between">
          <span className="text-muted">Launch type</span>
          <span className="text-txt">{app.launchType || "—"}</span>
        </div>
        {app.launchUrl ? (
          <div className="flex justify-between">
            <span className="text-muted">URL</span>
            <span className="text-txt truncate max-w-[260px]">
              {app.launchUrl}
            </span>
          </div>
        ) : null}
        {app.repository ? (
          <div className="flex justify-between">
            <span className="text-muted">Repository</span>
            <a
              href={app.repository}
              target="_blank"
              rel="noreferrer"
              className="text-accent hover:underline truncate max-w-[260px]"
            >
              GitHub
            </a>
          </div>
        ) : null}
      </div>

      {app.capabilities?.length ? (
        <div className="mb-5">
          <div className="text-[11px] text-muted mb-2 font-semibold uppercase tracking-wider">
            Capabilities
          </div>
          <div className="flex flex-wrap gap-1.5">
            {app.capabilities.map((capability) => (
              <span
                key={capability}
                className="text-[10px] px-2 py-0.5 rounded-full border border-border text-muted"
              >
                {capability}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      {app.viewer ? (
        <div className="mb-5 p-3 rounded-xl border border-border bg-surface">
          <div className="text-[11px] text-muted mb-2 font-semibold uppercase tracking-wider">
            Viewer
          </div>
          <div className="flex flex-col gap-1.5 text-[11px]">
            <div className="flex justify-between">
              <span className="text-muted">URL</span>
              <span className="text-txt truncate max-w-[240px]">
                {app.viewer.url}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted">Auth</span>
              <span className="text-txt">
                {app.viewer.postMessageAuth ? "enabled" : "disabled"}
              </span>
            </div>
          </div>
        </div>
      ) : null}

      {DetailExtension ? (
        <div className="border-t border-border pt-4">
          <DetailExtension app={app} />
        </div>
      ) : null}
    </>
  );
}
