import type { ResolvedContentPack } from "@elizaos/shared";

interface LoadedPacksListProps {
  loadedPacks: ResolvedContentPack[];
  activePackId: string | null;
  onToggle: (pack: ResolvedContentPack) => void;
}
export declare function LoadedPacksList({
  loadedPacks,
  activePackId,
  onToggle,
}: LoadedPacksListProps): import("react/jsx-runtime").JSX.Element | null;
//# sourceMappingURL=LoadedPacksList.d.ts.map
