export interface UseLinkedSidebarSelectionOptions<T extends string = string> {
  contentTopOffset?: number;
  selectedId: T | null;
  enabled?: boolean;
  topAlignedId?: T | null;
}
export declare function useLinkedSidebarSelection<T extends string = string>({
  contentTopOffset,
  enabled,
  selectedId,
  topAlignedId,
}: UseLinkedSidebarSelectionOptions<T>): {
  contentContainerRef: import("react").RefObject<HTMLDivElement | null>;
  queueContentAlignment: (id: T) => void;
  registerContentItem: (id: T) => (node: HTMLElement | null) => void;
  registerRailItem: (id: T) => (node: HTMLElement | null) => void;
  registerSidebarItem: (id: T) => (node: HTMLElement | null) => void;
  registerSidebarViewport: (node: HTMLElement | null) => void;
  scrollContentToItem: (id: T) => void;
};
//# sourceMappingURL=useLinkedSidebarSelection.d.ts.map
