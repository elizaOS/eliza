import type { RelationshipsPersonDetail } from "../../../api/client-types-relationships";
type RelationshipsDisplayPerson = RelationshipsPersonDetail;
export declare function RelationshipsPersonSummaryPanel({ person, compact, ownerGroupId, ownerDisplayName, onViewMemories, onOwnerNameUpdated, }: {
    person: RelationshipsDisplayPerson;
    compact?: boolean;
    ownerGroupId?: string | null;
    ownerDisplayName?: string | null;
    onViewMemories?: (entityIds: string[]) => void;
    onOwnerNameUpdated?: (next: string) => void;
}): import("react/jsx-runtime").JSX.Element;
export declare function RelationshipsFactsPanel({ person, }: {
    person: RelationshipsDisplayPerson;
}): import("react/jsx-runtime").JSX.Element;
export declare function RelationshipsConnectionsPanel({ person, }: {
    person: RelationshipsDisplayPerson;
}): import("react/jsx-runtime").JSX.Element;
export declare function RelationshipsConversationsPanel({ person, }: {
    person: RelationshipsDisplayPerson;
}): import("react/jsx-runtime").JSX.Element;
export declare function RelationshipsRelevantMemoriesPanel({ person, }: {
    person: RelationshipsDisplayPerson;
}): import("react/jsx-runtime").JSX.Element;
export declare function RelationshipsUserPreferencesPanel({ person, }: {
    person: RelationshipsDisplayPerson;
}): import("react/jsx-runtime").JSX.Element;
export declare function RelationshipsDocumentsPanel({ person, }: {
    person: RelationshipsDisplayPerson;
}): import("react/jsx-runtime").JSX.Element;
export {};
//# sourceMappingURL=RelationshipsPersonPanels.d.ts.map