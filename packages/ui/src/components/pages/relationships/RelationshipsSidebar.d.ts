import type { RelationshipsGraphSnapshot } from "../../../api/client-types-relationships";
export declare function RelationshipsSidebar({ search, graph, selectedPersonId, onSearchChange, onSearchClear, onSelectPersonId, }: {
    search: string;
    graph: RelationshipsGraphSnapshot | null;
    selectedPersonId: string | null;
    onSearchChange: (value: string) => void;
    onSearchClear: () => void;
    onSelectPersonId: (personId: string) => void;
}): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=RelationshipsSidebar.d.ts.map