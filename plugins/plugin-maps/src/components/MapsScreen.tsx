/**
 * The shared phone Maps screen: a full-bleed map with a search pill, saved
 * place chips, bottom sheets for results, place detail and routes, a
 * directions panel, and turn-by-turn guidance. All behaviour comes from
 * MapsScreenController; this view only renders its `view()` and forwards
 * input. It uses React and inline styles only, so a host can mount it outside
 * the app shell, and themes it through `--maps-*` custom properties.
 */
import {
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { Coordinate, Route, TravelMode } from "../client/contracts.ts";
import { maneuverIcon } from "../client/guidance.ts";
import type { MapOverlay } from "../client/map-plane.ts";
import type {
  MapsScreenHandle,
  MapsScreenView,
} from "../client/maps-screen.ts";

/** The host's map renderer (for example the plugin-maps MapLibre plane). */
export interface MapsScreenPlane {
  update(
    selected: Coordinate | undefined,
    route: Route | null,
    overlay: MapOverlay,
  ): void;
  destroy(): void;
}

/** 24px stroke icon paths; a host passes its own set to match its design. */
export interface MapsScreenIcons {
  search: string;
  back: string;
  close: string;
  pin: string;
  star: string;
  share: string;
  globe: string;
  locate: string;
  navigate: string;
  check: string;
  info: string;
  voice: string;
  modes: Record<TravelMode, string>;
}

export const DEFAULT_MAPS_SCREEN_ICONS: MapsScreenIcons = {
  search: "M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14zM21 21l-5-5",
  back: "M15 18l-6-6 6-6",
  close: "M18 6L6 18M6 6l12 12",
  pin: maneuverIcon("arrive"),
  star: "M12 3l2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3l-5.5 2.9 1-6.2L3 9.6l6.2-.9z",
  share: "M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7M16 6l-4-4-4 4M12 2v13",
  globe:
    "M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18zM3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18",
  locate: "M12 2v3M12 19v3M2 12h3M19 12h3M12 7a5 5 0 1 0 0 10a5 5 0 1 0 0-10z",
  navigate: "M3 11l19-9-9 19-2-8z",
  check: "M5 12l5 5 9-9",
  info: "M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18zM12 11v6M12 7h.01",
  voice: "M11 5L6 9H2v6h4l5 4zM15.5 8.5a5 5 0 0 1 0 7",
  modes: {
    drive: "M5 17h14M6 17v-6l2-5h8l2 5v6M7 17v2M17 17v2M6 11h12",
    transit: "M6 4h12v12H6zM6 11h12M8 19l-2 2M16 19l2 2",
    walk: "M13 4a1 1 0 1 0 0 2a1 1 0 1 0 0-2zM10 21l2-6 3 3v3M12 15l-1-5 4 2 2 3M11 10l-3 2v3",
    bicycle:
      "M5 14a3 3 0 1 0 0 6a3 3 0 1 0 0-6zM19 14a3 3 0 1 0 0 6a3 3 0 1 0 0-6zM5 17l4-8h6l4 8M9 9l3 8",
  },
};

const MODE_LABEL: Record<TravelMode, string> = {
  drive: "Drive",
  transit: "Transit",
  walk: "Walk",
  bicycle: "Bike",
};

/** Theme tokens; each falls back to the shared Eliza tokens. */
const color = {
  bg: "var(--maps-bg, var(--card, #fff))",
  fg: "var(--maps-fg, var(--text, #141414))",
  muted: "var(--maps-muted, var(--muted, #6b6b6b))",
  surface: "var(--maps-surface, var(--surface, #f1f1f1))",
  line: "var(--maps-line, var(--border, rgba(0, 0, 0, 0.08)))",
  accent: "var(--maps-accent, var(--accent, #ff5800))",
  accentText: "var(--maps-accent-text, #fff)",
  accentStrong: "var(--maps-accent-strong, var(--maps-accent, #d94b00))",
  link: "var(--maps-link, var(--maps-fg, var(--text, #141414)))",
  shadow: "var(--maps-shadow, rgba(0, 0, 0, 0.16))",
  guidance: "var(--maps-guidance, var(--maps-accent, #ff5800))",
  guidanceThen: "var(--maps-guidance-then, rgba(0, 0, 0, 0.35))",
  navBar: "var(--maps-nav-bar, #151515)",
  navButton: "var(--maps-nav-button, #262626)",
};
const font = "var(--maps-font, inherit)";
const textSize = (pixels: number) =>
  `calc(${pixels}px * var(--maps-text-scale, 1))`;
const displayFont = "var(--maps-display-font, var(--maps-font, inherit))";
const inset = {
  top: "var(--maps-inset-top, env(safe-area-inset-top, 0px))",
  right: "var(--maps-inset-right, env(safe-area-inset-right, 0px))",
  bottom:
    "calc(var(--maps-inset-bottom, env(safe-area-inset-bottom, 0px)) + var(--maps-bottom-clearance, 0px))",
  left: "var(--maps-inset-left, env(safe-area-inset-left, 0px))",
};

export interface MapsScreenProps {
  screen: MapsScreenHandle;
  /** Creates the host's map plane; without one the map area stays a plain surface. */
  createPlane?: (
    element: HTMLElement,
    onError: () => void,
    onPin: (id: string) => void,
  ) => MapsScreenPlane;
  /** Basemap and data credits, always visible over the map. */
  attribution: ReactNode;
  mapLabel?: string;
  /** Basemap privacy note in the map information panel. */
  mapPrivacy?: string;
  /** Location disclosure for search and routing (see describeMapsDisclosure). */
  disclosure?: string;
  /** Quick searches offered with an empty query. */
  categories?: readonly { label: string; icon?: string }[];
  /** The agent's display name for "Ask …" controls. */
  agentName?: string;
  onAskAgent?: (text: string) => void;
  /** Leaves Maps for the launcher. */
  onBack?: () => void;
  onOpenLocationSettings?: () => void;
  /** Return to the app (e.g. a Calendar event) whose hand-off opened Maps. */
  eventReturn?: { title: string; onReturn: () => void } | null;
  icons?: Partial<MapsScreenIcons>;
  /** Release the controller when the view unmounts (leaving Maps). Default true. */
  releaseOnUnmount?: boolean;
  style?: CSSProperties;
}

function Icon({ d, size = 24 }: { d: string; size?: number }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flexShrink: 0 }}
    >
      <path d={d} />
    </svg>
  );
}

const roundButton = (
  size: number,
  background = color.surface,
): CSSProperties => ({
  width: size,
  height: size,
  borderRadius: size / 2,
  background,
  color: "inherit",
  border: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  flexShrink: 0,
  cursor: "pointer",
  font: "inherit",
});

const pillButton = (background: string, foreground: string): CSSProperties => ({
  minHeight: 44,
  padding: "0 16px",
  borderRadius: 22,
  background,
  color: foreground,
  border: 0,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 8,
  fontWeight: 600,
  font: "inherit",
  cursor: "pointer",
});

const sheet: CSSProperties = {
  position: "absolute",
  left: 0,
  right: 0,
  bottom: 0,
  borderRadius: "28px 28px 0 0",
  background: color.bg,
  color: color.fg,
  boxShadow: `0 -10px 40px ${color.shadow}, 0 -1px 0 ${color.line}`,
  zIndex: 4,
  boxSizing: "border-box",
};

function onEnter(action: () => void) {
  return (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    action();
    event.currentTarget.blur();
  };
}

/** Renders one Maps screen controller. */
export function MapsScreen({
  screen,
  createPlane,
  attribution,
  mapLabel = "Map",
  mapPrivacy,
  disclosure,
  categories = [],
  agentName = "your agent",
  onAskAgent,
  onBack,
  onOpenLocationSettings,
  eventReturn,
  icons: iconOverrides,
  releaseOnUnmount = true,
  style,
}: MapsScreenProps) {
  useSyncExternalStore(screen.subscribe, screen.version, screen.version);
  const controller = screen.controller;
  const view: MapsScreenView = controller.view();
  const icons = { ...DEFAULT_MAPS_SCREEN_ICONS, ...iconOverrides };
  const root = useRef<HTMLElement | null>(null);
  const searchInput = useRef<HTMLInputElement | null>(null);
  const focusSearch = useRef(false);
  const scrollElement = useRef<HTMLDivElement | null>(null);
  const textMeasure = useRef<HTMLSpanElement | null>(null);
  const sheetElement = useRef<HTMLDivElement | null>(null);
  const primaryElement = useRef<HTMLDivElement | null>(null);
  const planeElement = useRef<HTMLDivElement | null>(null);
  const plane = useRef<MapsScreenPlane | null>(null);
  useLayoutEffect(() => {
    if (!focusSearch.current || !searchInput.current) return;
    focusSearch.current = false;
    searchInput.current.focus();
  });
  const [planeGeneration, setPlaneGeneration] = useState(0);
  const [size, setSize] = useState({
    width: 0,
    height: 0,
    sheetHeight: 0,
    primaryHeight: 0,
    textScale: 1,
  });
  const flowLayout =
    size.textScale >= 2 || (size.height > 0 && size.height < 360);
  const sideBySide =
    !flowLayout && size.width >= 720 && size.width > size.height * 1.2;
  const panelWidth = "min(440px, 50%)";
  const compactHeight = `calc((100% - ${inset.top} - ${inset.bottom} - 36px) / 2)`;
  const sheetClearance = Math.max(88, size.primaryHeight + 24);
  const sheetStyle: CSSProperties = {
    ...sheet,
    position: flowLayout ? "relative" : "absolute",
    left: flowLayout || sideBySide ? "auto" : inset.left,
    right: flowLayout ? "auto" : inset.right,
    bottom: flowLayout ? "auto" : inset.bottom,
    width: sideBySide ? panelWidth : undefined,
    maxHeight: flowLayout
      ? "none"
      : `calc(100% - ${inset.top} - ${inset.bottom} - ${sideBySide ? 24 : sheetClearance}px)`,
    overflowY: flowLayout ? "visible" : "auto",
    marginTop: flowLayout ? 12 : undefined,
    overscrollBehavior: "contain",
  };

  // Use the space the host gives this view, including split windows and keyboards.
  // biome-ignore lint/correctness/useExhaustiveDependencies: A mode change replaces the sheet DOM node that must be observed.
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    if (flowLayout && scrollElement.current)
      scrollElement.current.scrollTop = 0;
    const measure = () => {
      const bounds = element.getBoundingClientRect();
      const width = element.clientWidth || bounds.width;
      const height = element.clientHeight || bounds.height;
      const layoutScale = bounds.height > 0 ? height / bounds.height : 1;
      const sheetHeight =
        (sheetElement.current?.getBoundingClientRect().height ?? 0) *
        layoutScale;
      const primaryHeight =
        (primaryElement.current?.getBoundingClientRect().height ?? 0) *
        layoutScale;
      const textScale =
        Number.parseFloat(getComputedStyle(element).fontSize) / 16 || 1;
      setSize((previous) =>
        previous.width === width &&
        previous.height === height &&
        previous.sheetHeight === sheetHeight &&
        previous.primaryHeight === primaryHeight &&
        previous.textScale === textScale
          ? previous
          : {
              width,
              height,
              sheetHeight,
              primaryHeight,
              textScale,
            },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    if (sheetElement.current) observer.observe(sheetElement.current);
    if (primaryElement.current) observer.observe(primaryElement.current);
    if (textMeasure.current) observer.observe(textMeasure.current);
    return () => observer.disconnect();
  }, [view.mode, flowLayout]);

  const retryMap = () => {
    controller.retryMap();
    setPlaneGeneration((generation) => generation + 1);
  };

  // The map plane lives as long as the view; failures and readiness are reported to the screen.
  // biome-ignore lint/correctness/useExhaustiveDependencies: An explicit retry recreates the plane even when its factory is unchanged.
  useEffect(() => {
    const element = planeElement.current;
    if (!element || !createPlane) return;
    delete element.dataset.mapReady;
    delete element.dataset.mapError;
    let current = true;
    try {
      plane.current = createPlane(
        element,
        () => {
          if (current) controller.setMapState("error");
        },
        (id) => controller.pin(id),
      );
    } catch {
      controller.setMapState("error");
      return;
    }
    const observer = new MutationObserver(() => {
      if (current)
        controller.setMapState(
          element.dataset.mapReady === "true" ? "ready" : "loading",
        );
    });
    observer.observe(element, {
      attributes: true,
      attributeFilter: ["data-map-ready"],
    });
    return () => {
      current = false;
      observer.disconnect();
      plane.current?.destroy();
      plane.current = null;
    };
  }, [controller, createPlane, planeGeneration]);

  useEffect(() => {
    plane.current?.update(view.map.selected, view.map.route, view.map.overlay);
  });

  useEffect(
    () => () => {
      if (releaseOnUnmount) controller.release();
    },
    [controller, releaseOnUnmount],
  );

  const status = view.status;
  const place = view.place;
  const directions = view.directions;
  const navigation = view.navigation;
  const resultsSheet = view.mode === "results" || view.mode === "origin";

  const navigationSummary = navigation ? (
    <div style={{ flexGrow: 1, minWidth: 0, textAlign: "center" }}>
      <div
        style={{
          fontFamily: displayFont,
          fontSize: textSize(flowLayout ? 16 : 30),
          lineHeight: 1.05,
        }}
      >
        {navigation.remainingTime}
      </div>
      <div style={{ fontSize: textSize(13), color: "#8f8f8f", marginTop: 3 }}>
        {navigation.meta}
      </div>
      {navigation.offRoute ? (
        <button
          type="button"
          onClick={() => controller.reroute()}
          disabled={!navigation.canReroute}
          style={{
            ...pillButton(color.navButton, "#fff"),
            minHeight: 36,
            marginTop: 4,
            fontSize: textSize(13),
          }}
        >
          Reroute from here
        </button>
      ) : null}
    </div>
  ) : null;

  return (
    <section
      ref={root}
      data-maps-root
      data-map-diagnostics={JSON.stringify(view.diagnostics)}
      aria-label="Maps"
      style={{
        position: "relative",
        height: "100%",
        overflowX: "hidden",
        overflowY: "hidden",
        display: flowLayout ? "flex" : undefined,
        flexDirection: flowLayout ? "column" : undefined,
        boxSizing: "border-box",
        padding: flowLayout
          ? `calc(${inset.top} + 12px) calc(${inset.right} + 12px) calc(${inset.bottom} + 12px) calc(${inset.left} + 12px)`
          : undefined,
        background: color.surface,
        color: color.fg,
        fontFamily: font,
        fontSize: textSize(16),
        overflowWrap: "anywhere",
        ...style,
      }}
    >
      <span
        ref={textMeasure}
        aria-hidden="true"
        style={{
          position: "absolute",
          width: "1em",
          height: "1em",
          visibility: "hidden",
          pointerEvents: "none",
        }}
      />
      <div
        ref={scrollElement}
        data-maps-scroll
        style={{
          display: flowLayout ? "block" : "contents",
          position: flowLayout ? "relative" : undefined,
          flex: flowLayout ? 1 : undefined,
          minHeight: 0,
          overflowY: flowLayout ? "auto" : undefined,
        }}
      >
        <div
          ref={primaryElement}
          data-maps-primary
          style={{
            position: flowLayout ? "relative" : "absolute",
            top: flowLayout ? "auto" : `calc(${inset.top} + 12px)`,
            left: flowLayout ? "auto" : `calc(${inset.left} + 12px)`,
            right: flowLayout
              ? "auto"
              : sideBySide &&
                  (resultsSheet || place || directions || navigation)
                ? `calc(${inset.right} + ${panelWidth} + 12px)`
                : `calc(${inset.right} + ${navigation ? 80 : 12}px)`,
            maxHeight: flowLayout
              ? "none"
              : sideBySide
                ? `calc(100% - ${inset.top} - ${inset.bottom} - 24px)`
                : compactHeight,
            maxWidth: flowLayout
              ? undefined
              : sideBySide
                ? "min(440px, calc(50% - 24px))"
                : size.width >= 720
                  ? 560
                  : undefined,
            display: "flex",
            flexDirection: "column",
            gap: 8,
            overflowY: flowLayout ? "visible" : "auto",
            overscrollBehavior: "contain",
            zIndex: 5,
          }}
        >
          {view.showSearch ? (
            <div
              data-maps-search
              style={{
                position: "relative",
                order: 0,
                flexShrink: 0,
                minHeight: 54,
                borderRadius: 27,
                background: color.bg,
                boxShadow: `0 6px 22px ${color.shadow}, 0 0 0 1px ${color.line}`,
                display: "flex",
                alignItems: "center",
                padding: "0 5px",
                zIndex: 3,
              }}
            >
              {onBack && view.searchLead === "search" ? (
                <button
                  type="button"
                  aria-label="Back to apps"
                  onClick={onBack}
                  style={roundButton(44, "transparent")}
                >
                  <Icon d={icons.back} />
                </button>
              ) : null}
              <button
                type="button"
                aria-label={view.searchLead === "back" ? "Back" : "Search"}
                onClick={() => controller.searchLead()}
                style={roundButton(44, "transparent")}
              >
                <Icon
                  d={view.searchLead === "back" ? icons.back : icons.search}
                />
              </button>
              <input
                ref={searchInput}
                aria-label="Search places"
                placeholder="Search"
                value={view.query}
                onChange={(event) => controller.setQuery(event.target.value)}
                onClick={() => controller.focusQuery()}
                onKeyDown={onEnter(() => controller.submit())}
                style={{
                  flexGrow: 1,
                  minWidth: 0,
                  minHeight: 44,
                  border: 0,
                  outline: 0,
                  background: "transparent",
                  color: color.fg,
                  fontSize: textSize(16),
                  padding: "0 4px",
                  font: "inherit",
                }}
              />
              {view.query ? (
                <button
                  type="button"
                  aria-label="Clear search"
                  onClick={() => controller.clearQuery()}
                  style={roundButton(44, "transparent")}
                >
                  <Icon d={icons.close} size={18} />
                </button>
              ) : null}
            </div>
          ) : null}

          {eventReturn && (view.showSearch || view.mode === "directions") ? (
            <button
              type="button"
              data-maps-event-return
              aria-label="Back to event"
              title={eventReturn.title}
              onClick={eventReturn.onReturn}
              style={{
                position: "relative",
                order: 1,
                alignSelf: "flex-start",
                flexShrink: 0,

                ...pillButton(color.bg, color.fg),
                zIndex: 5,
                boxShadow: `0 6px 22px ${color.shadow}, 0 0 0 1px ${color.line}`,
              }}
            >
              <Icon d={icons.back} size={18} />
              Back to event
            </button>
          ) : null}

          {view.mode === "base" && view.saved.length ? (
            <div
              data-maps-saved
              style={{
                position: "relative",
                order: 2,
                flexShrink: 0,
                display: "flex",
                gap: 8,
                overflowX: "auto",
                padding: "0 12px 10px",
                zIndex: 3,
              }}
            >
              {view.saved.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => controller.chooseSaved(item.id)}
                  style={{
                    ...pillButton(color.bg, color.fg),
                    minHeight: 40,
                    boxShadow: `0 4px 14px ${color.shadow}, 0 0 0 1px ${color.line}`,
                  }}
                >
                  <Icon d={icons.pin} size={18} />
                  {item.label}
                </button>
              ))}
            </div>
          ) : null}

          {status.visible && view.mode !== "navigation" ? (
            <div
              data-maps-status
              data-location-state={status.location}
              data-map-state={status.map}
              style={{
                position: "relative",
                order: 3,
                flexShrink: 0,
                boxSizing: "border-box",
                zIndex: 5,
                padding: 12,
                borderRadius: 22,
                background: color.bg,
                color: color.muted,
                fontSize: textSize(14),
                lineHeight: 1.45,
                boxShadow: `0 0 0 1px ${color.line}`,
              }}
            >
              <p role="status" style={{ margin: 0 }}>
                {status.text}
              </p>
              {status.mapsAppHandoff ? (
                <button
                  type="button"
                  aria-label="Open in maps app"
                  onClick={() => controller.openInMapsApp()}
                  style={{
                    ...pillButton(color.accent, color.accentText),
                    marginTop: 8,
                  }}
                >
                  Open in maps app
                </button>
              ) : null}
              {status.controls ? (
                <>
                  {status.mapText ? (
                    <p style={{ margin: "6px 0" }}>{status.mapText}</p>
                  ) : null}
                  <p style={{ margin: "6px 0" }}>{status.locationHelp}</p>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                    <button
                      type="button"
                      aria-label={status.locationLabel}
                      disabled={status.locationBusy}
                      onClick={() => controller.locate()}
                      style={pillButton(color.accent, color.accentText)}
                    >
                      {status.locationLabel}
                    </button>
                    {status.locationDenied && onOpenLocationSettings ? (
                      <button
                        type="button"
                        aria-label="Location settings"
                        onClick={onOpenLocationSettings}
                        style={pillButton(color.surface, color.fg)}
                      >
                        Location settings
                      </button>
                    ) : null}
                  </div>
                </>
              ) : null}
              {status.mapRetry ? (
                <button
                  type="button"
                  aria-label="Retry map"
                  onClick={retryMap}
                  style={{
                    ...pillButton(color.surface, color.fg),
                    marginTop: 8,
                  }}
                >
                  Retry map
                </button>
              ) : null}
            </div>
          ) : null}

          {directions && view.mode === "directions" ? (
            <div
              data-maps-directions
              style={{
                position: "relative",
                order: 0,
                flexShrink: 0,
                boxSizing: "border-box",
                borderRadius: 26,
                background: color.bg,
                boxShadow: `0 6px 22px ${color.shadow}, 0 0 0 1px ${color.line}`,
                padding: "6px 12px 12px 4px",
                zIndex: 3,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <button
                  type="button"
                  aria-label="Back to place"
                  onClick={() => controller.back()}
                  style={roundButton(44, "transparent")}
                >
                  <Icon d={icons.back} />
                </button>
                <div
                  style={{
                    flexGrow: 1,
                    minWidth: 0,
                    display: "flex",
                    flexDirection: "column",
                    gap: 2,
                  }}
                >
                  <input
                    aria-label="Route origin coordinates"
                    placeholder="Origin latitude, longitude"
                    value={directions.originText}
                    onChange={(event) =>
                      controller.setOriginText(event.target.value)
                    }
                    onKeyDown={onEnter(() => controller.planOrigin())}
                    style={{
                      minHeight: 32,
                      border: 0,
                      background: "transparent",
                      color: color.fg,
                      fontSize: textSize(15),
                      width: "100%",
                      font: "inherit",
                    }}
                  />
                  <button
                    type="button"
                    aria-label="Use current location for route"
                    onClick={() => controller.locate()}
                    style={{
                      border: 0,
                      background: "transparent",
                      padding: 0,
                      fontSize: textSize(12),
                      textAlign: "left",
                      color: color.link,
                      cursor: "pointer",
                      font: "inherit",
                    }}
                  >
                    Use current location for route
                  </button>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 12,
                      minHeight: 32,
                      fontSize: textSize(15),
                      fontWeight: 600,
                    }}
                  >
                    <Icon d={icons.pin} size={18} />
                    {directions.name}
                  </div>
                </div>
              </div>
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 6,
                  margin: "8px 0 0 8px",
                }}
              >
                {directions.modes.map((choice) => (
                  <button
                    key={choice.mode}
                    type="button"
                    aria-label={MODE_LABEL[choice.mode]}
                    aria-pressed={choice.selected}
                    onClick={() => controller.setMode(choice.mode)}
                    style={{
                      ...pillButton(
                        choice.selected ? color.accent : color.surface,
                        choice.selected ? color.accentText : color.fg,
                      ),
                      flex: "1 1 auto",
                      minWidth: 0,
                      padding: "0 8px",
                      gap: 4,
                      minHeight: 40,
                      fontSize: textSize(13),
                      opacity: choice.available ? 1 : 0.6,
                    }}
                  >
                    <Icon d={icons.modes[choice.mode]} size={18} />
                    {MODE_LABEL[choice.mode]}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {navigation ? (
            <>
              <div
                data-maps-guidance
                style={{
                  position: "relative",
                  order: 0,
                  flexShrink: 0,
                  borderRadius: 28,
                  background: color.guidance,
                  color: "#fff",
                  padding: "18px 20px",
                  display: "flex",
                  alignItems: "center",
                  gap: 16,
                  zIndex: 5,
                }}
              >
                <Icon
                  d={navigation.arrived ? icons.check : navigation.maneuverIcon}
                  size={flowLayout ? 32 : 52}
                />
                <div style={{ minWidth: 0 }}>
                  <div
                    style={{
                      fontFamily: displayFont,
                      fontSize: textSize(flowLayout ? 16 : 40),
                      lineHeight: 1,
                    }}
                  >
                    {navigation.distance}
                  </div>
                  <div
                    style={{
                      fontSize: textSize(flowLayout ? 16 : 19),
                      fontWeight: 600,
                      marginTop: 4,
                      overflowWrap: "anywhere",
                    }}
                  >
                    {navigation.instruction}
                  </div>
                </div>
              </div>
              {navigation.following ? (
                <div
                  data-maps-following
                  style={{
                    position: "relative",
                    order: 1,
                    alignSelf: "flex-start",
                    flexShrink: 0,
                    minHeight: 40,
                    padding: "0 14px",
                    borderRadius: "0 0 16px 16px",
                    background: color.guidanceThen,
                    color: "#fff",
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    fontSize: textSize(14),
                    fontWeight: 600,
                    zIndex: 4,
                  }}
                >
                  Then
                  <Icon d={navigation.following.icon} size={20} />
                  <span
                    style={{
                      maxWidth: 220,
                      overflowWrap: "anywhere",
                    }}
                  >
                    {navigation.following.text}
                  </span>
                </div>
              ) : null}
              {flowLayout ? navigationSummary : null}
              {status.visible ? (
                <div
                  data-maps-navigation-status
                  style={{
                    position: "relative",
                    order: 3,
                    flexShrink: 0,
                    margin: 0,
                    padding: "10px 14px",
                    borderRadius: 16,
                    background: color.bg,
                    color: color.fg,
                    fontSize: textSize(14),
                    lineHeight: 1.45,
                    boxShadow: `0 0 0 1px ${color.line}`,
                    zIndex: 5,
                  }}
                >
                  <p role="status" style={{ margin: 0 }}>
                    {status.text}
                  </p>
                  {status.mapRetry ? (
                    <button
                      type="button"
                      onClick={retryMap}
                      style={{
                        ...pillButton(color.surface, color.fg),
                        marginTop: 8,
                      }}
                    >
                      Retry map
                    </button>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : null}
        </div>

        <div
          ref={planeElement}
          data-map-plane
          role="img"
          aria-label={mapLabel}
          style={{ position: "absolute", inset: 0, zIndex: 1 }}
        />
        <div
          data-maps-credits
          style={{
            position: flowLayout ? "relative" : "absolute",
            left: flowLayout
              ? "auto"
              : sideBySide && view.mode === "directions"
                ? `calc(100% - ${inset.right} - ${panelWidth} + 12px)`
                : `calc(${inset.left} + 12px)`,
            right: flowLayout
              ? "auto"
              : sideBySide &&
                  (resultsSheet || view.mode === "place" || navigation)
                ? `calc(${inset.right} + ${panelWidth} + 12px)`
                : `calc(${inset.right} + 12px)`,
            bottom: flowLayout
              ? "auto"
              : `calc(${inset.bottom} + ${view.mode === "navigation" ? (sideBySide ? 96 : 180) : sideBySide && view.mode !== "directions" ? 12 : size.sheetHeight + 12}px)`,
            marginTop: flowLayout ? 12 : undefined,
            zIndex: 2,
            display: "flex",
            alignItems: "flex-end",
            justifyContent: "space-between",
            gap: 8,
            fontSize: textSize(11),
            color: color.muted,
          }}
        >
          <span
            style={{
              background: color.bg,
              borderRadius: 8,
              padding: "2px 6px",
            }}
          >
            {attribution}
          </span>
          <details>
            <summary
              aria-label="Map information"
              title="Map information"
              style={{ listStyle: "none", cursor: "pointer" }}
            >
              <Icon d={icons.info} size={18} />
            </summary>
            <div
              style={{
                position: flowLayout ? "relative" : "absolute",
                right: 0,
                bottom: flowLayout ? "auto" : 28,
                maxWidth: flowLayout ? "none" : 300,
                padding: 12,
                borderRadius: 16,
                background: color.bg,
                color: color.fg,
                fontSize: textSize(13),
                boxShadow: `0 6px 22px ${color.shadow}`,
              }}
            >
              <button
                type="button"
                onClick={(event) => {
                  focusSearch.current = true;
                  event.currentTarget
                    .closest("details")
                    ?.removeAttribute("open");
                  controller.manualLocation();
                }}
                style={pillButton(color.surface, color.fg)}
              >
                Enter coordinates
              </button>
              {mapPrivacy ? <p>{mapPrivacy}</p> : null}
              {disclosure ? <p data-maps-disclosure>{disclosure}</p> : null}
            </div>
          </details>
        </div>

        {view.mode !== "navigation" ? (
          <button
            type="button"
            aria-label="Recenter"
            onClick={() => controller.recenter()}
            style={{
              ...roundButton(50, color.bg),
              position: flowLayout ? "relative" : "absolute",
              right: flowLayout
                ? "auto"
                : sideBySide && (resultsSheet || place || directions)
                  ? `calc(${inset.right} + ${panelWidth} + 16px)`
                  : `calc(${inset.right} + 16px)`,
              bottom: flowLayout
                ? "auto"
                : `calc(${inset.bottom} + ${sideBySide ? 64 : size.sheetHeight + 64}px)`,
              margin: flowLayout ? "12px 0 0 auto" : undefined,
              zIndex: 3,
              boxShadow: `0 6px 20px ${color.shadow}, 0 0 0 1px ${color.line}`,
            }}
          >
            <Icon d={icons.locate} />
          </button>
        ) : (
          <button
            type="button"
            aria-label="Recenter"
            onClick={() => controller.recenter()}
            style={{
              ...roundButton(54, color.navBar),
              color: "#fff",
              position: flowLayout ? "relative" : "absolute",
              right: flowLayout ? "auto" : `calc(${inset.right} + 16px)`,
              top: flowLayout ? "auto" : `calc(${inset.top} + 12px)`,
              margin: flowLayout ? "12px 0 0 auto" : undefined,
              zIndex: 3,
            }}
          >
            <Icon d={icons.locate} />
          </button>
        )}

        {resultsSheet ? (
          <div
            ref={sheetElement}
            data-maps-sheet="results"
            style={{
              ...sheetStyle,
              height: flowLayout ? "auto" : 520,
              display: "flex",
              flexDirection: "column",
              paddingTop: 20,
            }}
          >
            <div
              style={{
                flexGrow: 1,
                minHeight: 0,
                overflowY: "auto",
                paddingBottom: 24,
              }}
            >
              {view.emptyQuery ? (
                <>
                  {categories.length ? (
                    <div
                      style={{
                        display: "flex",
                        gap: 8,
                        overflowX: "auto",
                        padding: "4px 20px 14px",
                      }}
                    >
                      {categories.map((category) => (
                        <button
                          key={category.label}
                          type="button"
                          onClick={() => controller.searchFor(category.label)}
                          style={{
                            ...pillButton(color.surface, color.fg),
                            minHeight: 40,
                          }}
                        >
                          <Icon d={category.icon ?? icons.search} size={18} />
                          {category.label}
                        </button>
                      ))}
                    </div>
                  ) : null}
                  {view.saved.map((item) => (
                    <ResultRow
                      key={item.id}
                      icon={icons.pin}
                      name={item.label}
                      detail={`${item.coordinate.latitude.toFixed(5)}, ${item.coordinate.longitude.toFixed(5)}`}
                      onSelect={() => controller.chooseSaved(item.id)}
                    />
                  ))}
                </>
              ) : null}
              {view.results.map((row) => (
                <ResultRow
                  key={row.key}
                  icon={row.saved ? icons.star : icons.pin}
                  name={row.name}
                  detail={row.detail}
                  onSelect={() => controller.choose(row.key)}
                />
              ))}
              {view.noResults ? (
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    gap: 10,
                    padding: "18px 20px 6px",
                    color: color.muted,
                  }}
                >
                  <Icon d={icons.search} size={28} />
                  <div style={{ fontSize: textSize(15) }}>No places</div>
                  {onAskAgent ? (
                    <button
                      type="button"
                      onClick={() =>
                        onAskAgent(view.query || "Help me with Maps.")
                      }
                      style={pillButton(color.surface, color.fg)}
                    >
                      Ask {agentName} about this search
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
        ) : null}

        {place && view.mode === "place" ? (
          <div
            ref={sheetElement}
            data-maps-sheet="place"
            style={{ ...sheetStyle, padding: "18px 20px 24px" }}
          >
            <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
              <div style={{ flexGrow: 1, minWidth: 0 }}>
                {place.editingName ? (
                  <div style={{ display: "flex", gap: 8 }}>
                    <input
                      aria-label="Place name"
                      value={place.name}
                      maxLength={300}
                      onChange={(event) =>
                        controller.rename(event.target.value)
                      }
                      onKeyDown={onEnter(() => controller.applyName())}
                      style={{
                        minWidth: 0,
                        flexGrow: 1,
                        minHeight: 44,
                        padding: "0 14px",
                        border: 0,
                        borderRadius: 22,
                        background: color.surface,
                        color: color.fg,
                        fontSize: textSize(15),
                        font: "inherit",
                      }}
                    />
                    <button
                      type="button"
                      aria-label="Apply place name"
                      onClick={() => controller.applyName()}
                      style={pillButton(color.surface, color.fg)}
                    >
                      Done
                    </button>
                  </div>
                ) : (
                  <h1
                    style={{
                      margin: 0,
                      fontFamily: displayFont,
                      fontSize: textSize(flowLayout ? 20 : 32),
                      lineHeight: 1.1,
                    }}
                  >
                    <button
                      type="button"
                      aria-label="Rename place"
                      onClick={() => controller.startRename()}
                      style={{
                        border: 0,
                        padding: 0,
                        background: "transparent",
                        color: "inherit",
                        font: "inherit",
                        textAlign: "left",
                        cursor: "text",
                      }}
                    >
                      {place.name}
                    </button>
                  </h1>
                )}
                <div
                  style={{
                    fontSize: textSize(14),
                    color: color.muted,
                    marginTop: 6,
                  }}
                >
                  {place.meta}
                </div>
                {place.hours ? (
                  <div style={{ fontSize: textSize(14), marginTop: 4 }}>
                    <span style={{ fontWeight: 600 }}>Hours</span>
                    <span style={{ color: color.muted }}> · {place.hours}</span>
                  </div>
                ) : null}
              </div>
              <button
                type="button"
                aria-label="Close place"
                onClick={() => controller.closePlace()}
                style={roundButton(40)}
              >
                <Icon d={icons.close} size={18} />
              </button>
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 20 }}>
              {place.canDirections ? (
                <button
                  type="button"
                  aria-label="Directions"
                  onClick={() => controller.openDirections()}
                  style={{
                    ...pillButton(color.accent, color.accentText),
                    flexGrow: 1,
                    height: 52,
                    borderRadius: 26,
                  }}
                >
                  <Icon d={icons.modes.drive} />
                  Directions
                </button>
              ) : null}
              <button
                type="button"
                aria-label={place.saved ? "Remove from saved" : "Save"}
                aria-pressed={place.saved}
                onClick={() => controller.toggleSaved()}
                style={{
                  ...roundButton(52),
                  color: place.saved ? color.accentStrong : "inherit",
                }}
              >
                <Icon d={icons.star} />
              </button>
              <button
                type="button"
                aria-label="Share"
                onClick={() => controller.sharePlace()}
                style={roundButton(52)}
              >
                <Icon d={icons.share} />
              </button>
              {place.website ? (
                <button
                  type="button"
                  aria-label="Website"
                  onClick={() => controller.openWebsite()}
                  style={roundButton(52)}
                >
                  <Icon d={icons.globe} />
                </button>
              ) : null}
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                marginTop: 20,
                fontSize: textSize(14),
                color: color.muted,
              }}
            >
              <Icon d={icons.pin} size={18} />
              {place.address}
            </div>
          </div>
        ) : null}

        {directions && view.mode === "directions" ? (
          <div
            ref={sheetElement}
            data-maps-sheet="directions"
            style={{ ...sheetStyle, padding: "22px 20px 24px" }}
          >
            <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
              <span
                style={{
                  fontFamily: displayFont,
                  fontSize: textSize(flowLayout ? 20 : 44),
                  lineHeight: 1,
                }}
              >
                {directions.duration}
              </span>
              <span style={{ fontSize: textSize(15), color: color.muted }}>
                {directions.meta}
              </span>
            </div>
            <div
              style={{
                fontSize: textSize(14),
                color: color.muted,
                marginTop: 8,
              }}
            >
              {directions.via}
            </div>
            {directions.routes.length ? (
              <fieldset
                aria-label="Routes"
                data-maps-route-choice
                style={{
                  border: 0,
                  padding: 0,
                  minWidth: 0,
                  display: "flex",
                  flexDirection: "column",
                  gap: 6,
                  marginTop: 14,
                }}
              >
                {directions.routes.map((choice) => (
                  <button
                    key={choice.id}
                    type="button"
                    aria-pressed={choice.selected}
                    aria-label={`${choice.label}, ${choice.duration}, ${choice.meta}`}
                    onClick={() => controller.chooseRoute(choice.id)}
                    style={{
                      ...pillButton(
                        choice.selected ? color.accent : color.surface,
                        choice.selected ? color.accentText : color.fg,
                      ),
                      justifyContent: "space-between",
                      minHeight: 44,
                      padding: "0 16px",
                      fontSize: textSize(14),
                    }}
                  >
                    <span>{choice.label}</span>
                    <span>
                      {choice.duration} · {choice.meta}
                    </span>
                  </button>
                ))}
              </fieldset>
            ) : null}
            <div style={{ display: "flex", gap: 8, marginTop: 20 }}>
              <button
                type="button"
                onClick={() => controller.start()}
                style={{
                  ...pillButton(color.accent, color.accentText),
                  flexGrow: 1,
                  minHeight: 56,
                  borderRadius: 28,
                  fontSize: textSize(17),
                }}
              >
                <Icon d={icons.navigate} />
                Start
              </button>
              <button
                type="button"
                aria-label="Share route"
                onClick={() => controller.shareRoute()}
                style={roundButton(56)}
              >
                <Icon d={icons.share} />
              </button>
            </div>
          </div>
        ) : null}
      </div>
      {navigation ? (
        <div
          data-maps-navigation-controls
          style={{
            maxHeight: flowLayout ? "none" : compactHeight,
            overflowY: flowLayout ? "visible" : "auto",
            position: flowLayout ? "sticky" : "absolute",
            left:
              flowLayout || sideBySide ? "auto" : `calc(${inset.left} + 12px)`,
            right: flowLayout ? "auto" : `calc(${inset.right} + 12px)`,
            bottom: flowLayout ? 0 : `calc(${inset.bottom} + 12px)`,
            marginTop: flowLayout ? 12 : undefined,
            flexShrink: flowLayout ? 0 : undefined,
            width: sideBySide ? `calc(${panelWidth} - 24px)` : undefined,
            boxSizing: "border-box",
            borderRadius: 32,
            background: color.navBar,
            color: "#fff",
            padding: 10,
            display: "flex",
            alignItems: "center",
            justifyContent: flowLayout ? "space-between" : undefined,
            gap: 12,
            zIndex: 5,
          }}
        >
          <button
            type="button"
            aria-label="End navigation"
            onClick={() => controller.end()}
            style={roundButton(56, color.navButton)}
          >
            <Icon d={icons.close} />
          </button>
          {!flowLayout ? navigationSummary : null}
          {onAskAgent ? (
            <button
              type="button"
              aria-label={`Ask ${agentName}`}
              onClick={() => onAskAgent("Help me with this route.")}
              style={roundButton(56, color.navButton)}
            >
              <Icon d={icons.search} />
            </button>
          ) : null}
          <button
            type="button"
            aria-label={
              navigation.voiceEnabled
                ? "Mute voice guidance"
                : "Enable voice guidance"
            }
            aria-pressed={navigation.voiceEnabled}
            onClick={() => controller.toggleVoice()}
            style={roundButton(56, color.navButton)}
          >
            <Icon d={icons.voice} />
          </button>
        </div>
      ) : null}
    </section>
  );
}

function ResultRow({
  icon,
  name,
  detail,
  onSelect,
}: {
  icon: string;
  name: string;
  detail: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      style={{
        width: "100%",
        display: "flex",
        alignItems: "center",
        gap: 14,
        padding: "10px 20px",
        border: 0,
        background: "transparent",
        color: "inherit",
        textAlign: "left",
        cursor: "pointer",
        font: "inherit",
      }}
    >
      <span style={roundButton(42)}>
        <Icon d={icon} size={20} />
      </span>
      <span style={{ minWidth: 0 }}>
        <span
          style={{ display: "block", fontSize: textSize(16), fontWeight: 600 }}
        >
          {name}
        </span>
        <span
          style={{
            display: "block",
            fontSize: textSize(13),
            color: color.muted,
            marginTop: 2,
          }}
        >
          {detail}
        </span>
      </span>
    </button>
  );
}
