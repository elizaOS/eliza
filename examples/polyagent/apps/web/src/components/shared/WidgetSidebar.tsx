"use client";

import { useEffect, useRef, useState } from "react";
import { EntitySearchAutocomplete } from "@/components/explore/EntitySearchAutocomplete";
import { LatestNewsPanel } from "@/components/feed/LatestNewsPanel";
import { MarketsPanel } from "@/components/feed/MarketsPanel";
import { TrendingPanel } from "@/components/feed/TrendingPanel";

/**
 * Widget sidebar component for desktop layouts.
 *
 * Provides a sticky sidebar with search, latest news, trending, and markets
 * panels. Implements smart scrolling behavior on XL+ screens where the sidebar
 * translates vertically as the user scrolls to keep content visible. On smaller
 * screens, the sidebar is hidden.
 *
 * Features:
 * - Entity search autocomplete
 * - Latest news panel
 * - Trending panel
 * - Markets panel
 * - Smart sticky scrolling on XL+ screens
 *
 * @returns Widget sidebar element (hidden on screens < XL)
 */
export function WidgetSidebar() {
  const [searchQuery, setSearchQuery] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    const inner = innerRef.current;
    if (!container || !inner) return;

    // Only run on xl+ screens
    if (window.innerWidth < 1280) return;

    let lastScrollTop = 0;
    let direction: "up" | "down" = "down";
    let translateY = 0;
    let ticking = false;

    const updateSidebar = () => {
      const scrollTop = document.scrollingElement?.scrollTop || 0;
      const viewportHeight = window.innerHeight;
      const sidebarHeight = inner.offsetHeight;

      // Determine scroll direction
      if (scrollTop > lastScrollTop) {
        direction = "down";
      } else if (scrollTop < lastScrollTop) {
        direction = "up";
      }
      lastScrollTop = scrollTop;

      // Check if sidebar fits in viewport
      const fitsInViewport = sidebarHeight <= viewportHeight;

      // Check if NFT promo banner is visible (not dismissed)
      const bannerDismissed = localStorage.getItem("nft-banner-dismissed");
      const bannerOffset = bannerDismissed ? 0 : 40;

      if (fitsInViewport) {
        // Sidebar fits - simple sticky to top (below banner)
        inner.style.position = "fixed";
        inner.style.top = `${bannerOffset}px`;
        inner.style.transform = "";
      } else {
        // Sidebar is taller than viewport
        const effectiveViewportHeight = viewportHeight - bannerOffset;

        if (direction === "down") {
          // Scrolling down - sidebar bottom should stick to viewport bottom
          const maxTranslate = sidebarHeight - effectiveViewportHeight;

          // Calculate how much we should translate
          // As we scroll down, increase translateY until maxTranslate
          translateY = Math.min(scrollTop, maxTranslate);

          inner.style.position = "fixed";
          inner.style.top = `${bannerOffset}px`;
          inner.style.transform = `translateY(-${translateY}px)`;
        } else {
          // Scrolling up - keep current translation until we scroll back up enough
          const maxTranslate = sidebarHeight - effectiveViewportHeight;
          translateY = Math.min(scrollTop, maxTranslate);

          inner.style.position = "fixed";
          inner.style.top = `${bannerOffset}px`;
          inner.style.transform = `translateY(-${translateY}px)`;
        }
      }

      ticking = false;
    };

    const handleScroll = () => {
      if (!ticking) {
        requestAnimationFrame(updateSidebar);
        ticking = true;
      }
    };

    const handleResize = () => {
      if (window.innerWidth < 1280) {
        // Reset styles below breakpoint
        if (inner) {
          inner.style.position = "";
          inner.style.top = "";
          inner.style.transform = "";
        }
        return;
      }
      updateSidebar();
    };

    // Initialize
    updateSidebar();

    window.addEventListener("scroll", handleScroll, { passive: true });
    window.addEventListener("resize", handleResize, { passive: true });

    return () => {
      window.removeEventListener("scroll", handleScroll);
      window.removeEventListener("resize", handleResize);
    };
  }, []);

  return (
    <div ref={containerRef} className="hidden w-96 flex-none flex-col xl:flex">
      <div ref={innerRef} className="flex w-96 flex-col gap-6 px-4 py-6">
        <div className="flex-shrink-0">
          <EntitySearchAutocomplete
            value={searchQuery}
            onChange={setSearchQuery}
            placeholder="Search users..."
            searchType="users"
          />
        </div>

        <div className="flex-shrink-0">
          <LatestNewsPanel />
        </div>

        <div className="flex-shrink-0">
          <TrendingPanel />
        </div>

        <div className="flex-shrink-0">
          <MarketsPanel />
        </div>
      </div>
    </div>
  );
}
