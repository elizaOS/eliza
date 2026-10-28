/** Shared installed-app inventory. The host owns navigation, theme and storage identity. */
import {
  appKey,
  describeLauncherApps,
  filterLauncherApps,
  type InstalledApp,
  type Launcher,
} from "@elizaos/capacitor-system/launcher";
import type { CSSProperties, HTMLAttributes, ReactNode } from "react";
import * as React from "react";

export interface InstalledAppsLauncherProps
  extends HTMLAttributes<HTMLElement> {
  launcher: Launcher;
  query: string;
  onQuery: (query: string) => void;
  onClose?: () => void;
  productName?: string;
  builtinPrefix?: string;
  renderIcon?: (app: InstalledApp) => ReactNode;
}

const button: CSSProperties = {
  minWidth: 44,
  minHeight: 44,
  flexShrink: 0,
  border: 0,
  borderRadius: 18,
  background: "transparent",
  color: "inherit",
  cursor: "pointer",
};
const rowButton: CSSProperties = {
  ...button,
  flexGrow: 1,
  minWidth: 0,
  display: "flex",
  alignItems: "center",
  gap: 14,
  minHeight: 60,
  padding: "6px 12px",
  textAlign: "left",
  font: "inherit",
};
const muted: CSSProperties = {
  color: "var(--launcher-muted,var(--muted-foreground,currentColor))",
  fontSize: 12,
};
function Glyph({ path, filled = false }: { path: string; filled?: boolean }) {
  return (
    <svg
      aria-hidden="true"
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={path} />
    </svg>
  );
}
const STAR =
  "m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3l-5.6 2.9 1.1-6.2L3 9.6l6.2-.9L12 3Z";

export function InstalledAppsLauncher({
  launcher,
  query,
  onQuery,
  onClose,
  productName = "Eliza",
  builtinPrefix = "eliza:",
  renderIcon,
  style,
  ...attributes
}: InstalledAppsLauncherProps) {
  const snapshot = launcher.snapshot();
  const matching = filterLauncherApps(snapshot.apps, query);
  const pinned = query.trim() ? [] : launcher.favoriteApps();
  const pinnedKeys = new Set(pinned.map(appKey));
  const rows = matching.filter((app) => !pinnedKeys.has(appKey(app)));
  const details = describeLauncherApps(snapshot.apps, {
    productName,
    builtinPrefix,
  });
  const status =
    snapshot.status === "loading" || snapshot.status === "idle"
      ? "Reading installed apps…"
      : snapshot.status === "failed"
        ? "Installed apps could not be read."
        : !query.trim() &&
            !snapshot.apps.some(
              (app) => !app.packageName.startsWith(builtinPrefix),
            )
          ? "No other apps are installed."
          : !matching.length
            ? `No apps match “${query.trim()}”.`
            : "";

  const icon = (app: InstalledApp) =>
    app.icon ? (
      <img
        alt=""
        src={app.icon}
        style={{ width: 44, height: 44, borderRadius: 14, flexShrink: 0 }}
      />
    ) : (
      <span
        style={{
          width: 44,
          height: 44,
          borderRadius: 14,
          background: "var(--launcher-surface,var(--secondary,transparent))",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
      >
        {renderIcon?.(app) ?? (
          <Glyph path="M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z" />
        )}
      </span>
    );
  const renderRow = (app: InstalledApp, favoriteIndex?: number) => {
    const key = appKey(app);
    const parts = details.get(key) ?? [];
    const name = parts.length
      ? `${app.label} (${parts.join(", ")})`
      : app.label;
    const favorite = snapshot.favorites.includes(key);
    return (
      <div
        key={key}
        data-launcher-app={favoriteIndex === undefined ? key : undefined}
        data-launcher-favorite={favoriteIndex === undefined ? undefined : key}
        style={{ display: "flex", alignItems: "center", gap: 2 }}
      >
        <button
          type="button"
          onClick={() => void launcher.launch(app)}
          disabled={!!snapshot.launching}
          aria-label={`Open ${name}`}
          aria-busy={snapshot.launching === key}
          style={rowButton}
        >
          {icon(app)}
          <span
            style={{ display: "flex", flexDirection: "column", minWidth: 0 }}
          >
            <span
              style={{
                fontSize: 16,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {app.label}
            </span>
            {parts.length > 0 && (
              <span
                style={{
                  ...muted,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {parts.join(" · ")}
              </span>
            )}
          </span>
        </button>
        {favoriteIndex !== undefined && (
          <React.Fragment>
            <button
              type="button"
              className="ib"
              style={button}
              onClick={() => launcher.moveFavorite(app, -1)}
              disabled={favoriteIndex === 0}
              aria-label={`Move ${name} earlier`}
            >
              <Glyph path="m6 15 6-6 6 6" />
            </button>
            <button
              type="button"
              className="ib"
              style={button}
              onClick={() => launcher.moveFavorite(app, 1)}
              disabled={favoriteIndex === pinned.length - 1}
              aria-label={`Move ${name} later`}
            >
              <Glyph path="m6 9 6 6 6-6" />
            </button>
          </React.Fragment>
        )}
        <button
          type="button"
          className="ib"
          style={button}
          onClick={() => launcher.toggleFavorite(app)}
          aria-label={`${favorite ? "Remove" : "Add"} ${name} ${favorite ? "from" : "to"} favorites`}
          aria-pressed={favorite}
        >
          <Glyph path={STAR} filled={favorite} />
        </button>
      </div>
    );
  };
  return (
    <section
      {...attributes}
      style={{
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        background: "var(--launcher-background,var(--background,transparent))",
        color: "var(--launcher-foreground,var(--foreground,inherit))",
        ...style,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "0 12px 0 20px",
          flexShrink: 0,
        }}
      >
        <h1
          style={{
            margin: 0,
            fontSize: 32,
            flexGrow: 1,
            letterSpacing: "-.01em",
            fontFamily: "var(--launcher-title-font,inherit)",
            fontWeight: "var(--launcher-title-weight,inherit)",
          }}
        >
          All apps
        </h1>
        <span role="status" style={muted}>
          {snapshot.status === "ready"
            ? `${matching.length} ${matching.length === 1 ? "app" : "apps"}`
            : ""}
        </span>
        {onClose && (
          <button
            type="button"
            className="ib"
            style={button}
            aria-label="Close all apps"
            onClick={onClose}
          >
            <Glyph path="m6 6 12 12 M18 6 6 18" />
          </button>
        )}
      </div>
      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          margin: "12px 16px 8px",
          padding: "0 16px",
          minHeight: 48,
          borderRadius: 24,
          background: "var(--launcher-surface,var(--secondary,transparent))",
          flexShrink: 0,
        }}
      >
        <Glyph path="M21 21l-4.3-4.3 M19 11a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z" />
        <input
          type="search"
          aria-label="Search apps"
          placeholder="Search apps"
          value={query}
          onChange={(event) => {
            launcher.clearError();
            onQuery(event.target.value);
          }}
          style={{
            flexGrow: 1,
            minWidth: 0,
            border: 0,
            outline: 0,
            background: "transparent",
            color: "inherit",
            font: "inherit",
            fontSize: 16,
          }}
        />
      </label>
      {snapshot.launchError && (
        <p role="alert" style={{ margin: "4px 20px", fontSize: 14 }}>
          {snapshot.launchError}
        </p>
      )}
      <div
        className="scr"
        data-installed-apps-scroll=""
        style={{
          flexGrow: 1,
          minHeight: 0,
          overflowY: "auto",
          padding: "4px 8px",
          touchAction: "pan-y",
        }}
      >
        {snapshot.dial && !query.trim() && (
          <button
            type="button"
            onClick={() => void launcher.openDial()}
            disabled={!!snapshot.launching}
            aria-label={
              snapshot.dial.label
                ? `Open Phone (${snapshot.dial.label})`
                : "Open Phone"
            }
            style={{ ...rowButton, width: "100%" }}
          >
            {icon({
              packageName: "",
              label: "Phone",
              icon: snapshot.dial.icon,
            })}
            <span
              style={{ display: "flex", flexDirection: "column", minWidth: 0 }}
            >
              <span style={{ fontSize: 16 }}>Phone</span>
              <span style={muted}>
                {snapshot.dial.label || "Choose a phone app"}
              </span>
            </span>
          </button>
        )}
        {pinned.length > 0 && (
          <React.Fragment>
            <section aria-label="Favorites" data-launcher-favorites="">
              <h2 style={{ ...muted, margin: "8px 12px 2px", fontWeight: 400 }}>
                Favorites
              </h2>
              {pinned.map(renderRow)}
            </section>
            <h2 style={{ ...muted, margin: "14px 12px 2px", fontWeight: 400 }}>
              All apps
            </h2>
          </React.Fragment>
        )}
        {rows.map((app) => renderRow(app))}
        {status && (
          <div
            style={{
              padding: "28px 16px",
              textAlign: "center",
              ...muted,
              fontSize: 14,
            }}
          >
            <p role="status" style={{ margin: 0 }}>
              {status}
            </p>
            {snapshot.status === "failed" && (
              <button
                type="button"
                onClick={() => void launcher.load()}
                style={{
                  ...button,
                  marginTop: 12,
                  padding: "0 18px",
                  borderRadius: 22,
                  background:
                    "var(--launcher-surface,var(--secondary,transparent))",
                }}
              >
                Try again
              </button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
