import { useCallback, useEffect, useRef } from "react";

type ElementRecord<T extends string> = Partial<Record<T, HTMLElement | null>>;

export interface UseLinkedSidebarSelectionOptions<T extends string = string> {
  contentTopOffset?: number;
  selectedId: T | null;
  enabled?: boolean;
  topAlignedId?: T | null;
}

function scrollElementIntoNearestView(
  element: HTMLElement | null | undefined,
  alignToTop = false,
  behavior: ScrollBehavior = "smooth",
) {
  element?.scrollIntoView({
    behavior,
    block: alignToTop ? "start" : "nearest",
    inline: "nearest",
  });
}

function readElementAlignmentOffset(element: HTMLElement | null | undefined) {
  if (!element) return 0;
  const rawValue = element.dataset.contentAlignOffset;
  if (!rawValue) return 0;
  const parsed = Number(rawValue);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function useLinkedSidebarSelection<T extends string = string>({
  contentTopOffset = 16,
  enabled = true,
  selectedId,
  topAlignedId = null,
}: UseLinkedSidebarSelectionOptions<T>) {
  const contentContainerRef = useRef<HTMLDivElement | null>(null);
  const sidebarViewportRef = useRef<HTMLElement | null>(null);
  const contentRefs = useRef<ElementRecord<T>>({});
  const sidebarItemRefs = useRef<ElementRecord<T>>({});
  const railItemRefs = useRef<ElementRecord<T>>({});
  const pendingContentAlignmentRef = useRef<T | null>(null);
  const queuedAlignmentFrameRef = useRef<number | null>(null);
  const hasAppliedInitialSelectionRef = useRef(false);

  const registerContentItem = useCallback(
    (id: T) => (node: HTMLElement | null) => {
      contentRefs.current[id] = node;
    },
    [],
  );

  const registerSidebarItem = useCallback(
    (id: T) => (node: HTMLElement | null) => {
      sidebarItemRefs.current[id] = node;
    },
    [],
  );

  const registerRailItem = useCallback(
    (id: T) => (node: HTMLElement | null) => {
      railItemRefs.current[id] = node;
    },
    [],
  );

  const registerSidebarViewport = useCallback((node: HTMLElement | null) => {
    sidebarViewportRef.current = node;
  }, []);

  const scrollContentToItem = useCallback(
    (id: T) => {
      const scrollRoot = contentContainerRef.current;
      const element = contentRefs.current[id];
      const sidebarViewport = sidebarViewportRef.current;
      if (scrollRoot && element) {
        if (topAlignedId && id === topAlignedId) {
          scrollRoot.scrollTo({
            top: 0,
            behavior: "smooth",
          });
          return;
        }
        const elementRect = element.getBoundingClientRect();
        const nextTop = sidebarViewport
          ? scrollRoot.scrollTop +
            (elementRect.top - sidebarViewport.getBoundingClientRect().top)
          : scrollRoot.scrollTop +
            (elementRect.top - scrollRoot.getBoundingClientRect().top) -
            contentTopOffset +
            readElementAlignmentOffset(element);
        scrollRoot.scrollTo({
          top: Math.max(nextTop, 0),
          behavior: "smooth",
        });
        return;
      }
      element?.scrollIntoView({
        behavior: "smooth",
        block: topAlignedId && id === topAlignedId ? "start" : "nearest",
      });
    },
    [contentTopOffset, topAlignedId],
  );

  const queueContentAlignment = useCallback(
    (id: T) => {
      pendingContentAlignmentRef.current = id;
      if (!enabled) return;
      if (typeof window === "undefined") {
        pendingContentAlignmentRef.current = null;
        scrollContentToItem(id);
        return;
      }
      if (queuedAlignmentFrameRef.current != null) {
        window.cancelAnimationFrame(queuedAlignmentFrameRef.current);
      }
      queuedAlignmentFrameRef.current = window.requestAnimationFrame(() => {
        queuedAlignmentFrameRef.current = window.requestAnimationFrame(() => {
          const targetId = pendingContentAlignmentRef.current;
          pendingContentAlignmentRef.current = null;
          queuedAlignmentFrameRef.current = null;
          if (!targetId) return;
          scrollContentToItem(targetId);
        });
      });
    },
    [enabled, scrollContentToItem],
  );

  useEffect(
    () => () => {
      if (
        queuedAlignmentFrameRef.current != null &&
        typeof window !== "undefined"
      ) {
        window.cancelAnimationFrame(queuedAlignmentFrameRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    if (!enabled || !selectedId) return;
    const alignToTop = topAlignedId != null && selectedId === topAlignedId;
    const behavior = hasAppliedInitialSelectionRef.current ? "smooth" : "auto";
    hasAppliedInitialSelectionRef.current = true;
    scrollElementIntoNearestView(
      sidebarItemRefs.current[selectedId],
      alignToTop,
      behavior,
    );
    scrollElementIntoNearestView(
      railItemRefs.current[selectedId],
      alignToTop,
      behavior,
    );
  }, [enabled, selectedId, topAlignedId]);

  return {
    contentContainerRef,
    queueContentAlignment,
    registerContentItem,
    registerRailItem,
    registerSidebarItem,
    registerSidebarViewport,
    scrollContentToItem,
  };
}
