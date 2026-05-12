import { Skeleton } from "../ui/skeleton";
import { type MouseEvent, useEffect, useMemo, useRef, useState } from "react";
import type { RegistryAppInfo } from "../../api";
import { useApp } from "../../state";
import { AppHero } from "./app-identity";
import { getAppShortName, groupAppsForCatalog } from "./helpers";
import { getProvenanceFlags, getProvenanceTitle } from "./provenance";

interface AppsCatalogGridProps {
  activeAppNames: Set<string>;
  error: string | null;
  favoriteAppNames: Set<string>;
  loading: boolean;
  searchQuery: string;
  visibleApps: RegistryAppInfo[];
  onLaunch: (app: RegistryAppInfo) => void;
  onRetry?: () => void;
  onToggleFavorite: (appName: string) => void;
}

interface CatalogRenderSection {
  apps: RegistryAppInfo[];
  key: string;
  label: string;
}

interface PackedCatalogSection extends CatalogRenderSection {
  slots: number;
}

interface PackedCatalogRow {
  sections: PackedCatalogSection[];
  totalSlots: number;
}

const CARD_GAP_PX = 8;
const MAX_CARDS_PER_ROW = 5;
const MIN_CARD_WIDTH_PX = 248;

function clampCardsPerRow(value: number): number {
  return Math.min(Math.max(value, 1), MAX_CARDS_PER_ROW);
}

function resolveCardsPerRow(width: number): number {
  if (width <= 0) return MAX_CARDS_PER_ROW;
  const fit = Math.floor(
    (width + CARD_GAP_PX) / (MIN_CARD_WIDTH_PX + CARD_GAP_PX),
  );
  return clampCardsPerRow(fit);
}

function appProvenanceLabels(app: RegistryAppInfo): {
  originLabel: string | null;
  supportLabel: string | null;
  title: string | undefined;
} {
  const flags = getProvenanceFlags(app);
  return {
    originLabel: flags.isThirdParty
      ? "Third party"
      : flags.isBuiltIn
        ? "Built in"
        : null,
    supportLabel: flags.isCommunity
      ? "Community"
      : flags.isFirstParty
        ? "First party"
        : null,
    title: getProvenanceTitle(flags, "app"),
  };
}

function buildBalancedRows<T>(
  items: readonly T[],
  maxCardsPerRow: number,
): T[][] {
  if (items.length === 0) return [];

  const perRow = clampCardsPerRow(maxCardsPerRow);
  if (items.length <= perRow) {
    return [[...items]];
  }

  const rowCount = Math.ceil(items.length / perRow);
  const baseRowSize = Math.floor(items.length / rowCount);
  const oversizedRowCount = items.length % rowCount;
  const rows: T[][] = [];
  let index = 0;

  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    const size =
      rowIndex < rowCount - oversizedRowCount ? baseRowSize : baseRowSize + 1;
    rows.push(items.slice(index, index + size));
    index += size;
  }

  return rows;
}

function resolveSectionPreferredSlots(
  itemCount: number,
  maxCardsPerRow: number,
): number {
  return clampCardsPerRow(Math.min(Math.max(itemCount, 1), maxCardsPerRow));
}

function resolveSectionMinSlots(
  itemCount: number,
  maxCardsPerRow: number,
): number {
  const preferredSlots = resolveSectionPreferredSlots(
    itemCount,
    maxCardsPerRow,
  );
  if (itemCount <= 3 || preferredSlots <= 2) {
    return preferredSlots;
  }
  return Math.max(2, preferredSlots - 1);
}

function buildCatalogSectionRows(
  sections: readonly CatalogRenderSection[],
  maxCardsPerRow: number,
): PackedCatalogRow[] {
  if (sections.length === 0) {
    return [];
  }

  const rowCapacity = clampCardsPerRow(maxCardsPerRow);
  const rows: PackedCatalogRow[] = [];
  let sectionIndex = 0;

  while (sectionIndex < sections.length) {
    const rowSections: PackedCatalogSection[] = [];
    let usedSlots = 0;

    while (sectionIndex < sections.length) {
      const section = sections[sectionIndex];
      const preferredSlots = resolveSectionPreferredSlots(
        section.apps.length,
        rowCapacity,
      );
      const minSlots = resolveSectionMinSlots(section.apps.length, rowCapacity);
      const remainingSlots = rowCapacity - usedSlots;

      if (remainingSlots <= 0) {
        break;
      }

      let slots = preferredSlots;

      if (usedSlots === 0) {
        const nextSection = sections[sectionIndex + 1];
        if (
          nextSection &&
          preferredSlots === rowCapacity &&
          minSlots < preferredSlots
        ) {
          const nextMinSlots = resolveSectionMinSlots(
            nextSection.apps.length,
            rowCapacity,
          );
          if (minSlots + nextMinSlots <= rowCapacity) {
            slots = minSlots;
          }
        }
      } else if (preferredSlots > remainingSlots) {
        const leadSection = rowSections[0];
        const canPairSmallFavoritesWithFeatured =
          rowSections.length === 1 &&
          leadSection?.key === "favorites" &&
          leadSection.apps.length <= 2 &&
          section.key === "featured" &&
          remainingSlots >= 2;

        if (canPairSmallFavoritesWithFeatured) {
          slots = remainingSlots;
        } else if (minSlots <= remainingSlots) {
          slots = minSlots;
        } else {
          break;
        }
      }

      if (slots > remainingSlots) {
        if (rowSections.length > 0) {
          break;
        }
        slots = remainingSlots;
      }

      rowSections.push({
        ...section,
        slots,
      });
      usedSlots += slots;
      sectionIndex += 1;

      if (usedSlots >= rowCapacity) {
        break;
      }
    }

    if (rowSections.length === 0) {
      const section = sections[sectionIndex];
      rowSections.push({
        ...section,
        slots: resolveSectionPreferredSlots(section.apps.length, rowCapacity),
      });
      sectionIndex += 1;
    }

    rows.push({
      sections: rowSections,
      totalSlots: rowSections.reduce(
        (total, section) => total + section.slots,
        0,
      ),
    });
  }

  return rows;
}

function CatalogSkeletonSection({
  label,
  rowSizes,
}: {
  label: string;
  rowSizes: readonly number[];
}) {
  const rowDescriptors = useMemo(() => {
    const seenRowCounts = new Map<number, number>();
    return rowSizes.map((rowSize) => {
      const occurrence = (seenRowCounts.get(rowSize) ?? 0) + 1;
      seenRowCounts.set(rowSize, occurrence);
      const key = `${label}-${rowSize}-${occurrence}`;
      return {
        key,
        rowSize,
        cardKeys: Array.from(
          { length: rowSize },
          (_, position) => `${key}-${position + 1}`,
        ),
      };
    });
  }, [label, rowSizes]);

  return (
    <section className="space-y-3" aria-hidden="true">
      <div className="flex items-center gap-3">
        <Skeleton className="h-3 w-28 rounded-full bg-bg-accent/80" />
        <div className="h-px flex-1 bg-border/30" />
      </div>

      <div className="space-y-2">
        {rowDescriptors.map((rowDescriptor) => (
          <div
            key={rowDescriptor.key}
            className="grid gap-2"
            style={{
              gridTemplateColumns: `repeat(${rowDescriptor.rowSize}, minmax(0, 1fr))`,
            }}
          >
            {rowDescriptor.cardKeys.map((cardKey) => (
              <div
                key={cardKey}
                className="overflow-hidden rounded-2xl border border-border/35 bg-card/72"
              >
                <Skeleton className="aspect-[4/3] w-full rounded-none bg-bg-accent/70" />
                <div className="space-y-2 px-3 py-3">
                  <Skeleton className="h-3 w-2/3 rounded-full bg-bg-accent/80" />
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}

export function AppsCatalogGrid({
  activeAppNames,
  error,
  favoriteAppNames,
  loading,
  searchQuery,
  visibleApps,
  onLaunch,
  onRetry,
  onToggleFavorite,
}: AppsCatalogGridProps) {
  const { t } = useApp();
  const catalogRef = useRef<HTMLDivElement | null>(null);
  const [catalogWidth, setCatalogWidth] = useState(0);
  const cardsPerRow = useMemo(
    () => resolveCardsPerRow(catalogWidth),
    [catalogWidth],
  );
  const sections = useMemo(() => {
    return groupAppsForCatalog(visibleApps, {
      favoriteAppNames,
    });
  }, [favoriteAppNames, visibleApps]);
  const sectionRows = useMemo(
    () => buildCatalogSectionRows(sections, cardsPerRow),
    [cardsPerRow, sections],
  );

  useEffect(() => {
    const element = catalogRef.current;
    if (!element) return;

    const updateWidth = (width: number) => {
      setCatalogWidth(Math.max(0, Math.round(width)));
    };

    updateWidth(element.getBoundingClientRect().width);

    if (typeof ResizeObserver === "undefined") {
      return;
    }

    const observer = new ResizeObserver((entries) => {
      const nextWidth = entries[0]?.contentRect.width;
      if (typeof nextWidth === "number") {
        updateWidth(nextWidth);
      }
    });

    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={catalogRef} data-testid="apps-catalog-grid">
      {error ? (
        <div className="mb-4 flex flex-col gap-2 rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-xs-tight text-danger sm:flex-row sm:items-center sm:justify-between">
          <span>{error}</span>
          {onRetry ? (
            <button
              type="button"
              className="self-start rounded-full border border-danger/40 px-2.5 py-1 text-[0.68rem] font-semibold uppercase tracking-[0.14em] transition-colors hover:bg-danger/10 sm:self-auto"
              onClick={onRetry}
            >
              Retry
            </button>
          ) : null}
        </div>
      ) : null}

      {loading ? (
        <div
          className="space-y-6"
          role="status"
          aria-label={t("appsview.Loading")}
        >
          <CatalogSkeletonSection label="Featured" rowSizes={[1]} />
          <CatalogSkeletonSection
            label="Games & Entertainment"
            rowSizes={buildBalancedRows(
              Array.from({ length: 7 }),
              cardsPerRow,
            ).map((row) => row.length)}
          />
          <CatalogSkeletonSection
            label="Developer Utilities"
            rowSizes={buildBalancedRows(
              Array.from({ length: 6 }),
              cardsPerRow,
            ).map((row) => row.length)}
          />
        </div>
      ) : visibleApps.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border/35 bg-card/72 px-6 py-16 text-center">
          <div className="text-xs font-medium text-muted-strong">
            {searchQuery
              ? t("appsview.NoAppsMatchSearch")
              : t("appsview.NoAppsAvailable")}
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {sectionRows.map((sectionRow) => {
            const rowKey = sectionRow.sections
              .map((section) => section.key)
              .join("-");
            return (
              <div
                key={rowKey}
                data-testid={`apps-section-row-${rowKey}`}
                className="grid gap-4"
                style={{
                  gridTemplateColumns: `repeat(${sectionRow.totalSlots}, minmax(0, 1fr))`,
                }}
              >
                {sectionRow.sections.map((section) => (
                  <section
                    key={section.key}
                    data-testid={`apps-section-${section.key}`}
                    className="min-w-0 space-y-3"
                    style={{
                      gridColumn: `span ${section.slots} / span ${section.slots}`,
                    }}
                  >
                    <div className="flex items-center gap-3">
                      <h2 className="text-sm font-semibold text-muted-strong">
                        {section.label}
                      </h2>
                      <div className="h-px flex-1 bg-border/30" />
                    </div>

                    <div className="space-y-2">
                      {buildBalancedRows(section.apps, section.slots).map(
                        (row) => {
                          const sectionRowKey = row
                            .map((app) => app.name)
                            .join("-");
                          return (
                            <div
                              key={`${section.key}-${sectionRowKey}`}
                              className="grid gap-2"
                              style={{
                                gridTemplateColumns: `repeat(${row.length}, minmax(0, 1fr))`,
                              }}
                            >
                              {row.map((app) => {
                                const isActive = activeAppNames.has(app.name);
                                const isFavorite = favoriteAppNames.has(
                                  app.name,
                                );
                                const displayName =
                                  app.displayName ?? getAppShortName(app);
                                const provenanceLabels =
                                  appProvenanceLabels(app);

                                return (
                                  <div
                                    key={app.name}
                                    className={`group relative overflow-hidden rounded-2xl border bg-card/72 transition-all hover:border-accent/45 focus-within:ring-2 focus-within:ring-accent/35 ${
                                      isActive
                                        ? "border-ok/45 shadow-[0_0_0_1px_rgba(16,185,129,0.25)]"
                                        : "border-border/35 hover:shadow-[0_8px_24px_-12px_rgba(0,0,0,0.4)]"
                                    }`}
                                  >
                                    <button
                                      type="button"
                                      data-testid={`app-card-${app.name.replace(/[^a-z0-9]+/gi, "-")}`}
                                      title={displayName}
                                      aria-label={displayName}
                                      className="block w-full text-left focus-visible:outline-none"
                                      onClick={() => onLaunch(app)}
                                    >
                                      <AppHero
                                        app={app}
                                        className="aspect-[4/3] transition-transform duration-300 group-hover:scale-[1.02]"
                                      />
                                      {provenanceLabels.originLabel ||
                                      provenanceLabels.supportLabel ? (
                                        <div
                                          className="pointer-events-none absolute left-3 top-3 flex max-w-[calc(100%-4rem)] flex-wrap gap-1.5"
                                          title={provenanceLabels.title}
                                        >
                                          {provenanceLabels.originLabel ? (
                                            <span className="rounded-sm border border-white/20 bg-black/40 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-white backdrop-blur-sm">
                                              {provenanceLabels.originLabel}
                                            </span>
                                          ) : null}
                                          {provenanceLabels.supportLabel ? (
                                            <span
                                              className={`rounded-sm border px-1.5 py-0.5 text-[10px] font-semibold uppercase backdrop-blur-sm ${
                                                provenanceLabels.supportLabel ===
                                                "Community"
                                                  ? "border-warn/45 bg-black/40 text-warn"
                                                  : "border-accent/45 bg-black/40 text-white"
                                              }`}
                                            >
                                              {provenanceLabels.supportLabel}
                                            </span>
                                          ) : null}
                                        </div>
                                      ) : null}
                                      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end p-2 pe-10">
                                        <div className="min-w-0 flex-1">
                                          <div className="truncate text-xs font-semibold text-white drop-shadow-[0_1px_6px_rgba(0,0,0,0.6)]">
                                            {displayName}
                                          </div>
                                        </div>
                                      </div>
                                    </button>
                                    {isActive ? (
                                      <span
                                        title="Running"
                                        className="pointer-events-none absolute right-4 top-4 h-2.5 w-2.5 rounded-full bg-ok shadow-[0_0_0_3px_rgba(16,185,129,0.35)]"
                                      />
                                    ) : null}
                                    <button
                                      type="button"
                                      aria-label={
                                        isFavorite
                                          ? "Remove from favorites"
                                          : "Add to favorites"
                                      }
                                      className={`absolute bottom-3 right-3 rounded-full p-1.5 text-white transition-all ${
                                        isFavorite
                                          ? "bg-black/30 text-warn backdrop-blur-sm"
                                          : "bg-black/30 text-white/70 backdrop-blur-sm hover:text-warn focus-visible:text-warn"
                                      }`}
                                      onClick={(
                                        event: MouseEvent<HTMLButtonElement>,
                                      ) => {
                                        event.stopPropagation();
                                        onToggleFavorite(app.name);
                                      }}
                                    >
                                      <svg
                                        width="14"
                                        height="14"
                                        viewBox="0 0 24 24"
                                        fill={
                                          isFavorite ? "currentColor" : "none"
                                        }
                                        stroke="currentColor"
                                        strokeWidth="2"
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        aria-hidden="true"
                                      >
                                        <title>Favorite</title>
                                        <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                                      </svg>
                                    </button>
                                  </div>
                                );
                              })}
                            </div>
                          );
                        },
                      )}
                    </div>
                  </section>
                ))}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
