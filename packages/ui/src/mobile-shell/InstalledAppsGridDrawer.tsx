/** Installed apps in a searchable grid. The host owns drawer state, icons and theme. */
import {
  appKey,
  describeLauncherApps,
  filterLauncherApps,
  type InstalledApp,
  type Launcher,
} from "@elizaos/capacitor-system/launcher";
import {
  type CSSProperties,
  type HTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
} from "react";

/** A press held this long opens an entry's menu (drawer) or Home edit mode. */
export const HOLD_MS = 450;
/** Movement (CSS px) that turns a press into a scroll or a drag. */
export const SLOP = 10;
/** The drawer is a projection of the installed inventory. A resolved default handler does
 * not establish a listed launcher component and must not create a synthetic shortcut. */
export function appsDrawerEntries(
  snapshot: ReturnType<Launcher["snapshot"]>,
  builtinPrefix: string,
  query: string,
) {
  const installed = snapshot.apps.filter(
    (app) => !app.packageName.startsWith(builtinPrefix),
  );
  const details = describeLauncherApps(installed);
  return filterLauncherApps(installed, query).map((app) => ({
    key: appKey(app),
    app,
    target: app,
    detail: details.get(appKey(app)) || [],
  }));
}

export interface InstalledAppsGridDrawerProps
  extends HTMLAttributes<HTMLDivElement> {
  launcher: Launcher;
  builtinPrefix: string;
  query: string;
  onQuery: (query: string) => void;
  onClose: () => void;
  /** Entry whose menu is open. */
  menu: string | null;
  onMenu: (key: string | null) => void;
  onAddHome: (app: InstalledApp) => void;
  /** Absent when this platform cannot open Android's App info. */
  onAppInfo?: (app: InstalledApp) => void;
  /** Glyph URLs (single-colour masks). */
  glyphs: {
    app: string;
    phone: string;
    search: string;
    close: string;
    plus: string;
    info: string;
  };
  classes: {
    title?: string;
    iconButton?: string;
    scroller?: string;
    grid?: string;
  };
  gridAttributes?: {
    [attribute: `data-${string}`]: string | boolean | undefined;
  };
  [attribute: `data-${string}`]: string | boolean | undefined;
}

const mask = (url: string, size: number): CSSProperties => {
  const value = `url("${url}") center / contain no-repeat`;
  return {
    display: "block",
    width: size,
    height: size,
    flexShrink: 0,
    backgroundColor: "currentColor",
    mask: value,
    WebkitMask: value,
  };
};
/**
 * Keeps an opened menu inside the scroller that clips it: above its tile when there is no room
 * below, otherwise scrolled into view (the menu's backdrop blocks scrolling by hand).
 */
function placeMenu(menu: HTMLDivElement | null) {
  const scroller = menu?.closest<HTMLElement>("[data-installed-apps-scroll]"),
    tile = menu?.parentElement;
  if (!menu || !scroller || !tile) return;
  const room = scroller.getBoundingClientRect(),
    box = menu.getBoundingClientRect(),
    at = tile.getBoundingClientRect();
  if (box.bottom <= room.bottom && box.top >= room.top) return;
  if (box.bottom > room.bottom && at.top - box.height - 4 >= room.top) {
    menu.style.top = "auto";
    menu.style.bottom = "calc(100% + 4px)";
    menu.dataset.launcherMenuAbove = "";
    return;
  }
  menu.scrollIntoView({ block: "nearest" });
}
/** Keep the menu in view, then focus its first enabled command. */
function focusMenu(menu: HTMLDivElement | null) {
  placeMenu(menu);
  if (menu && !menu.contains(document.activeElement))
    menu
      .querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')
      ?.focus();
}
function menuKeys(
  event: ReactKeyboardEvent<HTMLDivElement>,
  close: () => void,
) {
  const items = [
    ...event.currentTarget.querySelectorAll<HTMLElement>(
      '[role="menuitem"]:not(:disabled)',
    ),
  ];
  if (event.key === "Tab") {
    close();
    return;
  }
  if (
    !items.length ||
    !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)
  )
    return;
  event.preventDefault();
  const at = items.indexOf(document.activeElement as HTMLElement);
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? items.length - 1
        : event.key === "ArrowDown"
          ? (at + 1) % items.length
          : (at - 1 + items.length) % items.length;
  items[next].focus();
}
const menuItem: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  width: "100%",
  minHeight: 44,
  padding: "0 10px",
  border: 0,
  borderRadius: 9,
  background: "none",
  color: "inherit",
  font: "inherit",
  fontSize: 14,
  textAlign: "left",
  cursor: "pointer",
};

export function InstalledAppsGridDrawer({
  launcher,
  builtinPrefix,
  query,
  onQuery,
  onClose,
  menu: requestedMenu,
  onMenu,
  onAddHome,
  onAppInfo,
  glyphs,
  classes,
  gridAttributes,
  style,
  onKeyDown,
  className,
  ...attributes
}: InstalledAppsGridDrawerProps) {
  const snapshot = launcher.snapshot();
  const entries = appsDrawerEntries(snapshot, builtinPrefix, query);
  const menu =
    requestedMenu && entries.some((entry) => entry.key === requestedMenu)
      ? requestedMenu
      : null;
  const loading = snapshot.status === "idle" || snapshot.status === "loading";
  const status =
    snapshot.status === "failed"
      ? "Apps could not be read."
      : snapshot.status === "ready" && !entries.length
        ? "No apps"
        : "";
  // Long press: the tap that ends it is swallowed, so it does not also open the entry.
  const press = useRef<{
    key: string;
    pointer: number;
    target: Element;
    x: number;
    y: number;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  const swallow = useRef("");
  const endPress = useCallback(() => {
    if (press.current) clearTimeout(press.current.timer);
    press.current = null;
  }, []);
  useLayoutEffect(() => endPress, [endPress]);
  useLayoutEffect(() => {
    if (press.current && !press.current.target.isConnected) endPress();
    if (
      swallow.current &&
      !entries.some((entry) => entry.key === swallow.current)
    )
      swallow.current = "";
    if (requestedMenu && !menu) onMenu(null);
  }, [endPress, entries, menu, onMenu, requestedMenu]);
  const releasePress = (event: ReactPointerEvent) => {
    if (press.current?.pointer === event.pointerId) endPress();
  };
  const hold = (key: string) => ({
    onPointerDown: (event: ReactPointerEvent) => {
      const pointer = event.pointerId;
      if (press.current && press.current.pointer !== pointer) return;
      swallow.current = "";
      endPress();
      if (event.button > 0) return;
      const target = event.currentTarget;
      const pending = {
        key,
        pointer,
        target,
        x: event.clientX,
        y: event.clientY,
        timer: setTimeout(() => {
          if (press.current !== pending) return;
          press.current = null;
          if (!target.isConnected || !scope.current?.contains(target)) return;
          swallow.current = key;
          onMenu(key);
        }, HOLD_MS),
      };
      press.current = pending;
    },
    onPointerMove: (event: ReactPointerEvent) => {
      if (
        press.current?.key === key &&
        press.current.pointer === event.pointerId &&
        Math.hypot(
          event.clientX - press.current.x,
          event.clientY - press.current.y,
        ) > SLOP
      )
        endPress();
    },
    onPointerUp: releasePress,
    onPointerCancel: releasePress,
    onContextMenu: (event: ReactMouseEvent) => {
      event.preventDefault();
      endPress();
      swallow.current = key;
      onMenu(key);
    },
  });
  const tapped = (key: string) => {
    const held = swallow.current === key;
    swallow.current = "";
    return !held;
  };
  const scope = useRef<HTMLDivElement>(null),
    opened = useRef<string | null>(null);
  useEffect(() => {
    const previous = opened.current;
    opened.current = menu;
    if (!previous || menu !== null) return;
    const root = scope.current,
      active = document.activeElement;
    // A newly opened menu or deliberately moved focus owns its destination.
    if (
      !root?.isConnected ||
      document.hidden ||
      (active &&
        active !== document.body &&
        (!root.contains(active) || !active.closest("[data-launcher-menu]")))
    )
      return;
    root
      .querySelector<HTMLElement>(
        `[data-launcher-app="${CSS.escape(previous)}"] > button`,
      )
      ?.focus();
  }, [menu]);
  return (
    <div
      ref={scope}
      role="dialog"
      aria-modal="true"
      aria-label="Apps"
      {...attributes}
      className={className}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (event.key !== "Escape" || event.defaultPrevented) return;
        event.preventDefault();
        event.stopPropagation();
        if (menu) onMenu(null);
        else onClose();
      }}
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        boxSizing: "border-box",
        background: "var(--bg)",
        color: "var(--fg, var(--text))",
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
          className={classes.title}
          style={{
            margin: 0,
            fontSize: 32,
            flexGrow: 1,
            letterSpacing: "-.01em",
            fontWeight: 300,
          }}
        >
          Apps
        </h1>
        <button
          type="button"
          className={classes.iconButton}
          aria-label="Close apps"
          onClick={onClose}
        >
          <span aria-hidden="true" style={mask(glyphs.close, 20)} />
        </button>
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
          background: "var(--s2, var(--surface))",
          color: "var(--mut, var(--muted))",
          flexShrink: 0,
        }}
      >
        <span aria-hidden="true" style={mask(glyphs.search, 18)} />
        <input
          type="search"
          aria-label="Search apps"
          placeholder="Search apps"
          autoComplete="off"
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
            color: "var(--fg, var(--text))",
            font: "inherit",
            fontSize: 16,
          }}
        />
      </label>
      {snapshot.launchError ? (
        <p role="alert" style={{ margin: "4px 20px", fontSize: 14 }}>
          {snapshot.launchError}
        </p>
      ) : null}
      {menu ? (
        <button
          type="button"
          aria-label="Close menu"
          tabIndex={-1}
          onClick={() => onMenu(null)}
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 1,
            border: 0,
            background: "transparent",
          }}
        />
      ) : null}
      <div
        className={classes.scroller}
        data-installed-apps-scroll=""
        aria-busy={loading || undefined}
        style={{
          flexGrow: 1,
          minHeight: 0,
          overflowY: "auto",
          padding: "4px 8px",
          touchAction: "pan-y",
        }}
      >
        <div
          className={classes.grid}
          {...gridAttributes}
          style={
            {
              "--fit-columns": 4,
              "--fit-min": "62px",
              rowGap: 20,
              padding: "6px 2px",
            } as CSSProperties
          }
        >
          {entries.map(({ key, app, target, detail }) => {
            const name = detail.length
              ? `${app.label} (${detail.join(", ")})`
              : app.label;
            const aria = `Open ${name}`;
            const open = menu === key,
              onHome = !!target && launcher.isFavorite(target);
            return (
              <div
                key={key}
                data-launcher-app={key}
                {...(target ? hold(key) : {})}
                style={{
                  position: "relative",
                  display: "flex",
                  justifyContent: "center",
                  minWidth: 0,
                }}
              >
                <button
                  type="button"
                  aria-label={aria}
                  aria-busy={snapshot.launching === key || undefined}
                  disabled={!!snapshot.launching}
                  onClick={() => {
                    if (!tapped(key)) return;
                    void launcher.launch(app);
                  }}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    gap: 8,
                    minWidth: 0,
                    width: "100%",
                    border: 0,
                    padding: 0,
                    background: "none",
                    color: "inherit",
                    font: "inherit",
                    cursor: "pointer",
                  }}
                >
                  {app.icon ? (
                    <img
                      alt=""
                      src={app.icon}
                      style={{ width: 56, height: 56, borderRadius: 18 }}
                    />
                  ) : (
                    <span
                      style={{
                        width: 56,
                        height: 56,
                        borderRadius: 18,
                        background: "var(--s2, var(--surface))",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      <span aria-hidden="true" style={mask(glyphs.app, 26)} />
                    </span>
                  )}
                  <span
                    style={{
                      fontSize: 12,
                      maxWidth: "100%",
                      textAlign: "center",
                      overflowWrap: "anywhere",
                    }}
                  >
                    {app.label}
                  </span>
                  {detail.length ? (
                    <span
                      style={{
                        fontSize: 11,
                        color: "var(--mut, var(--muted))",
                        maxWidth: "100%",
                        textAlign: "center",
                        overflowWrap: "anywhere",
                      }}
                    >
                      {detail.join(" · ")}
                    </span>
                  ) : null}
                </button>
                {open && target ? (
                  <div
                    role="menu"
                    aria-label={app.label}
                    data-launcher-menu=""
                    ref={focusMenu}
                    onKeyDown={(event) => menuKeys(event, () => onMenu(null))}
                    style={{
                      position: "absolute",
                      top: 72,
                      left: "50%",
                      transform: "translateX(-50%)",
                      zIndex: 2,
                      minWidth: 170,
                      padding: 6,
                      borderRadius: 14,
                      background: "var(--bg)",
                      color: "var(--fg, var(--text))",
                      boxShadow: "0 10px 30px rgba(0,0,0,.2)",
                    }}
                  >
                    <button
                      type="button"
                      role="menuitem"
                      tabIndex={-1}
                      disabled={onHome}
                      onClick={() => {
                        onMenu(null);
                        if (!onHome) onAddHome(target);
                      }}
                      style={{ ...menuItem, opacity: onHome ? 0.5 : 1 }}
                    >
                      <span aria-hidden="true" style={mask(glyphs.plus, 18)} />
                      {onHome ? "On Home" : "Add to Home"}
                    </button>
                    {onAppInfo ? (
                      <button
                        type="button"
                        role="menuitem"
                        tabIndex={-1}
                        onClick={() => {
                          onMenu(null);
                          onAppInfo(target);
                        }}
                        style={menuItem}
                      >
                        <span
                          aria-hidden="true"
                          style={mask(glyphs.info, 18)}
                        />
                        App info
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
        {status ? (
          <div
            style={{
              padding: "28px 16px",
              textAlign: "center",
              color: "var(--mut, var(--muted))",
              fontSize: 14,
            }}
          >
            <p role="status" style={{ margin: 0 }}>
              {status}
            </p>
            {snapshot.status === "failed" ? (
              <button
                type="button"
                onClick={() => void launcher.load()}
                style={{
                  minHeight: 44,
                  marginTop: 12,
                  padding: "0 18px",
                  border: 0,
                  borderRadius: 22,
                  background: "var(--s2, var(--surface))",
                  color: "inherit",
                  font: "inherit",
                }}
              >
                Try again
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
