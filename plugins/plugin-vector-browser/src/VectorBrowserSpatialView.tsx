/**
 * VectorBrowserSpatialView — the spatial-TUI fallback for the vector-browser
 * view, authored once with the spatial vocabulary so it renders correctly
 * wherever it is displayed:
 *
 *   - GUI — the adaptive `VectorBrowserView` wrapper renders the rich WebGL
 *     surface (`VectorBrowserRichView`) through a spatial `Escape`, with THIS
 *     view (a summary-stats + points-list fallback) as the `Escape` fallback.
 *     Only the GUI modality ships; "xr" and "tui" remain compatibility values.
 *
 * It is purely presentational (a flat snapshot + an action callback in,
 * primitives out) and imports ONLY the cross-modality primitives, so it is safe
 * to render in the Node agent process where the terminal lives — no heavy
 * client, no three.js, no `@elizaos/ui` shell-host import reaches the bundle.
 */

import {
  Button,
  Card,
  Divider,
  HStack,
  List,
  Text,
  VStack,
} from "@elizaos/ui/spatial";

/** A flat, terminal-safe preview of one memory/embedding point. */
export interface VectorBrowserPoint {
  id: string;
  type: string;
  /** Short content snippet (kept brief by the snapshot mapping). */
  content: string;
}

/**
 * Flat, presentational snapshot of the vector-browser state. Derived entirely
 * from the loaded memories + selected table; carries no client handles, no
 * embeddings, and no three.js geometry — only what the terminal can draw.
 */
export interface VectorBrowserSnapshot {
  /** Total memories in the selected table (the full count, not the page). */
  vectorCount: number;
  /** How many of the loaded memories carry an embedding vector. */
  withEmbeddings: number;
  /** Embedding dimension (length of the first embedding), or 0 if none. */
  dimension: number;
  /** Distinct memory `type`s among loaded memories — the cluster count. */
  typeCount: number;
  /** The selected table name, if a table is selected. */
  selectedTable?: string;
  /** The selected memory/point, if one is focused in the GUI. */
  selected?: VectorBrowserPoint | null;
  /** A short preview of the loaded memories (first N), drawn as the list. */
  points: VectorBrowserPoint[];
  loading?: boolean;
  error?: string | null;
}

export interface VectorBrowserSpatialViewProps {
  snapshot: VectorBrowserSnapshot;
  /** Dispatched action ids: `refresh`. */
  onAction?: (action: string) => void;
}

export function VectorBrowserSpatialView({
  snapshot,
  onAction,
}: VectorBrowserSpatialViewProps) {
  const {
    vectorCount,
    withEmbeddings,
    dimension,
    typeCount,
    selectedTable,
    selected,
    points,
    loading,
    error,
  } = snapshot;

  return (
    <Card gap={1} padding={1}>
      <HStack gap={1} align="center">
        <Text style="caption" tone="success" grow={1}>
          {loading ? "loading" : `${vectorCount} vectors`}
        </Text>
        <Text style="caption" tone="muted">
          {selectedTable ? `table ${selectedTable}` : "memory browser"}
        </Text>
      </HStack>

      {error ? (
        <Text tone="danger" style="caption">
          {error}
        </Text>
      ) : null}

      <Divider label="summary" />
      <Text wrap={false}>vectors {vectorCount}</Text>
      <Text wrap={false}>with embeddings {withEmbeddings}</Text>
      <Text wrap={false}>dim {dimension}</Text>
      <Text wrap={false}>clusters/types {typeCount}</Text>
      <Text wrap={false}>table {selectedTable ?? "—"}</Text>

      {selected ? (
        <>
          <Divider label="selected" />
          <VStack gap={0}>
            <Text bold wrap={false}>
              {selected.id}
            </Text>
            <Text style="caption" tone="muted" wrap={false}>
              {selected.type}
            </Text>
            <Text style="caption" wrap={false}>
              {selected.content}
            </Text>
          </VStack>
        </>
      ) : null}

      <Divider label="points" />
      {points.length === 0 ? (
        <Text tone="muted" align="center" style="caption">
          None
        </Text>
      ) : (
        <List gap={1}>
          {points.slice(0, 8).map((point) => (
            <HStack key={point.id} gap={1} align="center">
              <Text tone="primary">•</Text>
              <VStack gap={0} grow={1}>
                <Text bold wrap={false}>
                  {point.type || "memory"}
                </Text>
                <Text style="caption" tone="muted" wrap={false}>
                  {point.content}
                </Text>
              </VStack>
            </HStack>
          ))}
        </List>
      )}

      <Text tone="muted" style="caption">
        3D point cloud renders in GUI/XR
      </Text>
      <Button agent="refresh" onPress={() => onAction?.("refresh")}>
        Refresh
      </Button>
    </Card>
  );
}

export default VectorBrowserSpatialView;
