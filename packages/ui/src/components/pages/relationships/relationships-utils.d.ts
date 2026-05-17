import type {
  RelationshipsGraphQuery,
  RelationshipsGraphSnapshot,
  RelationshipsMergeCandidate,
  RelationshipsPersonDetail,
  RelationshipsPersonSummary,
} from "../../../api/client-types-relationships";

type PersonContactRow = {
  label: string;
  value: string;
};
export declare function buildRelationshipsGraphQuery(
  search: string,
  platform: string,
  limit?: number,
): RelationshipsGraphQuery;
export declare function sortPeople(
  people: RelationshipsPersonSummary[],
): RelationshipsPersonSummary[];
export declare function summarizeHandles(
  person: RelationshipsPersonSummary,
): string;
export declare function platformOptions(
  snapshot: RelationshipsGraphSnapshot | null,
): string[];
export declare function topContacts(
  person: RelationshipsPersonDetail,
): PersonContactRow[];
export declare function profileSourceLabel(source: string): string;
export declare function profilePrimaryValue(
  person: RelationshipsPersonDetail,
  source: string,
): string | null;
export declare function personLabel(
  graph: RelationshipsGraphSnapshot | null,
  entityId: string,
): string;
export declare function evidenceSummary(
  candidate: RelationshipsMergeCandidate,
): string;
//# sourceMappingURL=relationships-utils.d.ts.map
