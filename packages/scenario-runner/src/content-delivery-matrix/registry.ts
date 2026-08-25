/**
 * The first-lane content-delivery matrix registry (#23105): the declared
 * rows and the declared capabilities they must cover. Per the maintainer
 * disposition, this lane certifies Discord→Telegram text + file delivery on
 * the repository's wire-mock seams; live-credential acceptance is a later
 * lane. Adding a connector pair here without adding covering rows makes the
 * completeness gate fail — extend rows and capabilities together.
 */

import type { CompiledContentDeliveryMatrix } from "./compiler";
import {
  assertDeliveryCoverage,
  compileContentDeliveryMatrix,
} from "./compiler";
import type {
  ContentDeliveryMatrixRow,
  DeclaredDeliveryCapability,
} from "./schema";

/** Rows the first lane certifies. */
export const FIRST_LANE_DELIVERY_ROWS: readonly ContentDeliveryMatrixRow[] = [
  {
    id: "discord-to-telegram.text",
    schema: 1,
    sourceConnector: "discord",
    targetConnector: "telegram",
    contentKind: "text",
    transformClass: "verbatim-text",
    requiredProofs: ["provider-receipt", "byte-hash", "readback"],
  },
  {
    id: "discord-to-telegram.file",
    schema: 1,
    sourceConnector: "discord",
    targetConnector: "telegram",
    contentKind: "file",
    transformClass: "byte-preserving-file",
    requiredProofs: ["provider-receipt", "byte-hash", "readback"],
  },
];

/** Capabilities the connector pairs declare for this lane. */
export const FIRST_LANE_DECLARED_CAPABILITIES: readonly DeclaredDeliveryCapability[] =
  [
    {
      sourceConnector: "discord",
      targetConnector: "telegram",
      contentKind: "text",
    },
    {
      sourceConnector: "discord",
      targetConnector: "telegram",
      contentKind: "file",
    },
  ];

/**
 * The compiled first-lane matrix. Construction is fail-closed: the declared
 * capabilities are asserted against the rows at module-load time, so adding a
 * capability without a covering row fails the first import, not only a test
 * that remembers to call the gate.
 */
export const firstLaneDeliveryMatrix: CompiledContentDeliveryMatrix =
  compileFirstLaneDeliveryMatrix();

function compileFirstLaneDeliveryMatrix(): CompiledContentDeliveryMatrix {
  const matrix = compileContentDeliveryMatrix(FIRST_LANE_DELIVERY_ROWS);
  assertDeliveryCoverage(FIRST_LANE_DECLARED_CAPABILITIES, matrix);
  return matrix;
}
