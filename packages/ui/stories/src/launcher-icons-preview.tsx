/**
 * Interactive launcher icon-pack lab. It compares complete third-party packs,
 * supports per-app overrides, and queues bespoke icons for later generation.
 */
import { Button } from "@ui-src/components/ui/button.tsx";
import { Sparkles } from "lucide-react";
import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import "@ui-src/styles/styles.css";
import {
  CUSTOM_ICON_BRIEFS,
  LAUNCHER_APPS,
  LAUNCHER_PACKS,
  type LauncherApp,
  type LauncherAppId,
  type LauncherPackId,
  launcherIconUrl,
  launcherPack,
} from "./launcher-icon-packs";
import "./launcher-icons-preview.css";

declare global {
  var __elizaLauncherIconPreviewRoot: Root | undefined;
}

type IconChoice = LauncherPackId | "custom";

const STORAGE_KEY = "eliza-launcher-icon-pack-lab";

interface SavedLabState {
  globalPack?: LauncherPackId;
  selectedAppId?: LauncherAppId;
  overrides?: Partial<Record<LauncherAppId, IconChoice>>;
}

function readSavedLabState(): SavedLabState {
  try {
    return JSON.parse(
      localStorage.getItem(STORAGE_KEY) ?? "{}",
    ) as SavedLabState;
  } catch {
    return {};
  }
}

function PackIcon({
  app,
  choice,
  className,
}: {
  app: LauncherApp;
  choice: IconChoice;
  className?: string;
}) {
  if (choice === "custom") {
    return (
      <span
        className={`pack-icon-art pack-icon-art--custom ${className ?? ""}`}
      >
        <Sparkles aria-hidden="true" className="!size-[48%]" />
      </span>
    );
  }

  return (
    <span className={`pack-icon-art ${className ?? ""}`} data-pack={choice}>
      <span className="pack-icon-fallback" aria-hidden="true">
        {app.label.slice(0, 1)}
      </span>
      <img
        src={launcherIconUrl(app, choice)}
        alt=""
        aria-hidden="true"
        draggable={false}
        onError={(event) => {
          event.currentTarget.dataset.failed = "true";
        }}
      />
    </span>
  );
}

function PackRow({
  packId,
  active,
  onChoose,
}: {
  packId: LauncherPackId;
  active: boolean;
  onChoose: () => void;
}) {
  const pack = launcherPack(packId);
  return (
    <Button
      variant="selection"
      size="content"
      data-state={active ? "on" : "off"}
      className="pack-row"
      onClick={onChoose}
      aria-pressed={active}
    >
      <span className="pack-row-samples" aria-hidden="true">
        {LAUNCHER_APPS.slice(1, 4).map((app) => (
          <PackIcon key={app.id} app={app} choice={pack.id} />
        ))}
      </span>
      <span className="pack-row-copy">
        <span className="pack-row-title">
          <strong>{pack.name}</strong>
          <span>{pack.style}</span>
        </span>
        <span className="pack-row-meta">
          {pack.total} · {pack.license}
        </span>
        <span className="pack-row-note">{pack.note}</span>
      </span>
    </Button>
  );
}

function LauncherIconPackLab() {
  const saved = useMemo(readSavedLabState, []);
  const [globalPack, setGlobalPack] = useState<LauncherPackId>(
    saved.globalPack ?? "ionicons",
  );
  const [selectedAppId, setSelectedAppId] = useState<LauncherAppId>(
    saved.selectedAppId ?? "settings",
  );
  const [overrides, setOverrides] = useState<
    Partial<Record<LauncherAppId, IconChoice>>
  >(saved.overrides ?? {});

  const selectedApp =
    LAUNCHER_APPS.find((app) => app.id === selectedAppId) ?? LAUNCHER_APPS[0];
  const customCount = Object.values(overrides).filter(
    (choice) => choice === "custom",
  ).length;
  const overrideCount = Object.keys(overrides).length;
  const global = launcherPack(globalPack);
  const customBrief = CUSTOM_ICON_BRIEFS[selectedApp.id];

  useEffect(() => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ globalPack, selectedAppId, overrides }),
    );
  }, [globalPack, selectedAppId, overrides]);

  const resolvedChoices = useMemo(
    () =>
      Object.fromEntries(
        LAUNCHER_APPS.map((app) => [app.id, overrides[app.id] ?? globalPack]),
      ) as Record<LauncherAppId, IconChoice>,
    [globalPack, overrides],
  );

  const chooseForSelected = (choice: IconChoice) => {
    setOverrides((current) => ({ ...current, [selectedApp.id]: choice }));
  };

  const useGlobalForSelected = () => {
    setOverrides((current) => {
      const next = { ...current };
      delete next[selectedApp.id];
      return next;
    });
  };

  return (
    <main className="icon-lab-shell">
      <header className="icon-lab-header">
        <div>
          <p className="icon-lab-eyebrow">Eliza design workshop</p>
          <h1>Launcher icon pack lab</h1>
          <p className="icon-lab-subtitle">
            Pick one family, mix individual apps, then queue genuinely missing
            icons for GPT-Image-2.
          </p>
        </div>
        <div className="icon-lab-summary">
          <span>
            <strong>{global.name}</strong>
            global pack
          </span>
          <span>
            <strong>{overrideCount}</strong>
            overrides
          </span>
          <span>
            <strong>{customCount}</strong>
            custom queue
          </span>
        </div>
      </header>

      <div className="icon-lab-layout">
        <aside className="pack-browser" aria-label="Global icon pack">
          <div className="panel-heading">
            <p>Global pack</p>
            <span>Applies everywhere without an override.</span>
          </div>
          <div className="pack-list">
            {LAUNCHER_PACKS.map((pack) => (
              <PackRow
                key={pack.id}
                packId={pack.id}
                active={pack.id === globalPack}
                onChoose={() => setGlobalPack(pack.id)}
              />
            ))}
          </div>
          <p className="pack-source-note">
            Live SVG previews via Iconify. The approved family will be vendored
            from its official package before shipping.
          </p>
        </aside>

        <section className="phone-column" aria-label="Launcher preview">
          <div className="launcher-device">
            <header className="launcher-device-header">
              <span>9:41</span>
              <span>{overrideCount === 0 ? global.style : "Mixed pack"}</span>
            </header>
            <div className="launcher-pack-grid">
              {LAUNCHER_APPS.map((app) => {
                const choice = resolvedChoices[app.id];
                const selected = app.id === selectedApp.id;
                const overridden = overrides[app.id] !== undefined;
                return (
                  <Button
                    key={app.id}
                    variant="launcherTile"
                    size="content"
                    aria-label={`Edit ${app.label} icon`}
                    aria-pressed={selected}
                    className="launcher-pack-tile"
                    data-selected={selected || undefined}
                    onClick={() => setSelectedAppId(app.id)}
                  >
                    <span className="launcher-pack-icon-wrap">
                      <PackIcon app={app} choice={choice} />
                      {overridden ? (
                        <span className="override-mark" aria-hidden="true">
                          {choice === "custom" ? "AI" : "Mix"}
                        </span>
                      ) : null}
                    </span>
                    <span className="launcher-pack-label">{app.label}</span>
                  </Button>
                );
              })}
            </div>
          </div>
        </section>

        <aside
          className="icon-inspector"
          aria-label="Selected app icon choices"
        >
          <div className="inspector-app-heading">
            <div>
              <p>Selected app</p>
              <h2>{selectedApp.label}</h2>
            </div>
            <PackIcon
              app={selectedApp}
              choice={resolvedChoices[selectedApp.id]}
              className="inspector-current-icon"
            />
          </div>

          <div className="panel-heading">
            <p>Choose this icon</p>
            <span>Overrides only {selectedApp.label}.</span>
          </div>
          <div className="inspector-choice-grid">
            {LAUNCHER_PACKS.map((pack) => {
              const active = resolvedChoices[selectedApp.id] === pack.id;
              return (
                <Button
                  key={pack.id}
                  variant="selection"
                  size="content"
                  aria-pressed={active}
                  data-state={active ? "on" : "off"}
                  className="inspector-choice"
                  onClick={() => chooseForSelected(pack.id)}
                >
                  <PackIcon app={selectedApp} choice={pack.id} />
                  <span>
                    <strong>{pack.name}</strong>
                    <small>{pack.style}</small>
                  </span>
                </Button>
              );
            })}
            <Button
              variant="selection"
              size="content"
              aria-pressed={resolvedChoices[selectedApp.id] === "custom"}
              data-state={
                resolvedChoices[selectedApp.id] === "custom" ? "on" : "off"
              }
              className="inspector-choice inspector-choice--custom"
              onClick={() => chooseForSelected("custom")}
            >
              <PackIcon app={selectedApp} choice="custom" />
              <span>
                <strong>Custom</strong>
                <small>GPT-Image-2 queue</small>
              </span>
            </Button>
          </div>

          <div className="generation-brief">
            <Sparkles aria-hidden="true" className="!size-5" />
            <div>
              <strong>
                {customBrief
                  ? "Custom candidate recommended"
                  : "Generation happens after style lock"}
              </strong>
              <p>
                {customBrief ??
                  "The chosen pack becomes the reference for silhouette, weight, palette, layer count, and optical size."}
              </p>
            </div>
          </div>

          <div className="inspector-actions">
            <Button
              variant="ghostMuted"
              size="sm"
              onClick={useGlobalForSelected}
              disabled={overrides[selectedApp.id] === undefined}
            >
              Use global choice
            </Button>
            <Button
              variant="ghostMuted"
              size="sm"
              onClick={() => setOverrides({})}
              disabled={overrideCount === 0}
            >
              Reset all overrides
            </Button>
          </div>
        </aside>
      </div>
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("launcher icon preview root is missing");

const previewRoot =
  globalThis.__elizaLauncherIconPreviewRoot ?? createRoot(root);
globalThis.__elizaLauncherIconPreviewRoot = previewRoot;

previewRoot.render(
  <StrictMode>
    <LauncherIconPackLab />
  </StrictMode>,
);
