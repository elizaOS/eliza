/**
 * Gallery page client component displaying user's AI-generated media.
 * Supports filtering by type (all, image, video) and displays stats and grid view.
 * Uses per-tab caching to prevent unnecessary refetches on tab switch.
 */
"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { Skeleton } from "@/components/ui/skeleton";
import { GalleryGrid, GalleryGridSkeleton } from "./gallery-grid";
import { listUserMedia, getUserMediaStats } from "@/app/actions/gallery";
import type { GalleryItem } from "@/app/actions/gallery";
import {
  ImageIcon,
  VideoIcon,
  LayoutGridIcon,
  AlertCircle,
  RefreshCw,
} from "lucide-react";
import { useSetPageHeader } from "@/components/layout/page-header-context";
import {
  BrandTabsResponsive,
  BrandTabsContent,
  BrandCard,
  BrandButton,
} from "@/components/brand";
import type { TabItem } from "@/components/brand";

type TabType = "all" | "image" | "video";

const GALLERY_ITEMS_LIMIT = 100;
const SLOW_LOADING_TIMEOUT_MS = 10000;

type ItemsCache = {
  [K in TabType]?: GalleryItem[];
};

export function GalleryPageClient() {
  const searchParams = useSearchParams();
  const router = useRouter();

  // Get initial tab from URL query param
  const initialTab = useMemo(() => {
    const tabParam = searchParams.get("tab");
    if (tabParam === "image" || tabParam === "video") {
      return tabParam;
    }
    return "all";
  }, [searchParams]);

  useSetPageHeader({
    title: "Gallery",
    description: "View and manage your AI-generated images and videos",
  });

  const [activeTab, setActiveTab] = useState<TabType>(initialTab);
  const [itemsCache, setItemsCache] = useState<ItemsCache>({});
  const [loadingTabs, setLoadingTabs] = useState<Set<TabType>>(
    new Set([initialTab]),
  );
  const [isLoadingStats, setIsLoadingStats] = useState(true);
  const [stats, setStats] = useState<{
    totalImages: number;
    totalVideos: number;
    totalSize: number;
  } | null>(null);
  const [errorTabs, setErrorTabs] = useState<Set<TabType>>(new Set());
  const [slowLoadingTabs, setSlowLoadingTabs] = useState<Set<TabType>>(
    new Set(),
  );

  const fetchingTabsRef = useRef<Set<TabType>>(new Set());
  const loadingTimeoutRef = useRef<Map<TabType, NodeJS.Timeout>>(new Map());
  const itemsCacheRef = useRef<ItemsCache>(itemsCache);
  itemsCacheRef.current = itemsCache;

  // Update URL when tab changes
  const handleTabChange = useCallback(
    (tab: TabType) => {
      setActiveTab(tab);
      const url = new URL(window.location.href);
      if (tab === "all") {
        url.searchParams.delete("tab");
      } else {
        url.searchParams.set("tab", tab);
      }
      router.replace(url.pathname + url.search, { scroll: false });
    },
    [router],
  );

  const galleryTabs: TabItem[] = useMemo(
    () => [
      {
        value: "all",
        label: "All Media",
        icon: <LayoutGridIcon className="h-4 w-4" />,
      },
      {
        value: "image",
        label: stats ? `Images (${stats.totalImages})` : "Images",
        icon: <ImageIcon className="h-4 w-4" />,
      },
      {
        value: "video",
        label: stats ? `Videos (${stats.totalVideos})` : "Videos",
        icon: <VideoIcon className="h-4 w-4" />,
      },
    ],
    [stats],
  );

  const loadItemsForTab = useCallback(async (tab: TabType, force = false) => {
    if (!force && itemsCacheRef.current[tab] !== undefined) return;

    if (fetchingTabsRef.current.has(tab)) return;
    fetchingTabsRef.current.add(tab);

    setLoadingTabs((prev) => new Set(prev).add(tab));

    const timeoutId = setTimeout(() => {
      setSlowLoadingTabs((prev) => new Set(prev).add(tab));
    }, SLOW_LOADING_TIMEOUT_MS);
    loadingTimeoutRef.current.set(tab, timeoutId);

    try {
      const type = tab === "all" ? undefined : tab;
      const data = await listUserMedia({ type, limit: GALLERY_ITEMS_LIMIT });
      setItemsCache((prev) => ({ ...prev, [tab]: data }));
      setErrorTabs((prev) => {
        const next = new Set(prev);
        next.delete(tab);
        return next;
      });
    } catch (error) {
      console.error(`Failed to load items for tab ${tab}:`, error);
      setErrorTabs((prev) => new Set(prev).add(tab));
    } finally {
      const timeoutId = loadingTimeoutRef.current.get(tab);
      if (timeoutId) {
        clearTimeout(timeoutId);
        loadingTimeoutRef.current.delete(tab);
      }
      setSlowLoadingTabs((prev) => {
        const next = new Set(prev);
        next.delete(tab);
        return next;
      });
      fetchingTabsRef.current.delete(tab);
      setLoadingTabs((prev) => {
        const next = new Set(prev);
        next.delete(tab);
        return next;
      });
    }
  }, []);

  const loadStats = useCallback(async () => {
    setIsLoadingStats(true);
    const data = await getUserMediaStats();
    setStats(data);
    setIsLoadingStats(false);
  }, []);

  useEffect(() => {
    loadItemsForTab(activeTab);
  }, [activeTab, loadItemsForTab]);

  useEffect(() => {
    loadStats();
  }, [loadStats]);

  useEffect(() => {
    const timeoutRef = loadingTimeoutRef.current;
    return () => {
      timeoutRef.forEach((id) => clearTimeout(id));
      timeoutRef.clear();
    };
  }, []);

  const handleItemDeleted = useCallback(
    (itemId: string, itemType: "image" | "video") => {
      const tabsAffected: TabType[] = ["all", itemType];

      setItemsCache((prev) => {
        const next = { ...prev };
        for (const tab of tabsAffected) {
          if (next[tab]) {
            next[tab] = next[tab]!.filter((item) => item.id !== itemId);
          }
        }
        return next;
      });

      setStats((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          totalImages:
            itemType === "image" ? prev.totalImages - 1 : prev.totalImages,
          totalVideos:
            itemType === "video" ? prev.totalVideos - 1 : prev.totalVideos,
        };
      });
    },
    [],
  );

  const currentItems = itemsCache[activeTab] ?? [];
  const isLoading =
    loadingTabs.has(activeTab) && itemsCache[activeTab] === undefined;
  const hasError =
    errorTabs.has(activeTab) && itemsCache[activeTab] === undefined;
  const isSlowLoading = slowLoadingTabs.has(activeTab) && isLoading;

  const handleRetry = useCallback(() => {
    setErrorTabs((prev) => {
      const next = new Set(prev);
      next.delete(activeTab);
      return next;
    });
    loadItemsForTab(activeTab, true);
  }, [activeTab, loadItemsForTab]);

  return (
    <div className="flex flex-col gap-6">
      <BrandTabsResponsive
        id="gallery-tabs"
        tabs={galleryTabs}
        value={activeTab}
        onValueChange={(v) => handleTabChange(v as "all" | "image" | "video")}
      >
        <BrandTabsContent value={activeTab} className="mt-6">
          {isLoading ? (
            <>
              <GalleryGridSkeleton />
              {isSlowLoading && (
                <div className="flex flex-col items-center justify-center mt-6 gap-3">
                  <p className="text-sm text-white/60">
                    Taking longer than expected...
                  </p>
                  <BrandButton
                    variant="outline"
                    size="sm"
                    onClick={handleRetry}
                  >
                    <RefreshCw className="w-4 h-4 mr-2" />
                    Retry
                  </BrandButton>
                </div>
              )}
            </>
          ) : hasError ? (
            <BrandCard corners={false} className="p-8">
              <div className="flex flex-col items-center justify-center gap-4 text-center">
                <div className="rounded-full bg-red-500/20 border border-red-500/40 p-3">
                  <AlertCircle className="w-6 h-6 text-red-400" />
                </div>
                <div className="space-y-1">
                  <p className="text-lg font-medium text-white">
                    Failed to load media
                  </p>
                  <p className="text-sm text-white/50">
                    There was an error loading your gallery items.
                  </p>
                </div>
                <BrandButton
                  variant="outline"
                  onClick={handleRetry}
                  className="mt-2"
                >
                  <RefreshCw className="w-4 h-4 mr-2" />
                  Try Again
                </BrandButton>
              </div>
            </BrandCard>
          ) : (
            <GalleryGrid
              items={currentItems}
              onItemDeleted={handleItemDeleted}
            />
          )}
        </BrandTabsContent>
      </BrandTabsResponsive>
    </div>
  );
}
