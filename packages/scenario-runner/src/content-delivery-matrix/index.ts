/** Public surface of the content-delivery matrix (#23105 first lane). */
export {
  assertDeliveryCoverage,
  type CompiledContentDeliveryMatrix,
  compileContentDeliveryMatrix,
} from "./compiler";
export {
  assertBytePreservingDelivery,
  assertVerbatimTextDelivery,
  CONTENT_DELIVERY_PROOF_KINDS,
  type ContentDeliveryProofKind,
  type DeliveryProviderReceipt,
  deliveryPayloadSha256,
  verifyDeliveryReceipt,
} from "./proofs";
export {
  FIRST_LANE_DECLARED_CAPABILITIES,
  FIRST_LANE_DELIVERY_ROWS,
  firstLaneDeliveryMatrix,
} from "./registry";
export {
  CONTENT_DELIVERY_MATRIX_SCHEMA,
  type ContentDeliveryMatrixRow,
  DELIVERY_CONNECTORS,
  DELIVERY_CONTENT_KINDS,
  DELIVERY_TRANSFORM_CLASSES,
  type DeclaredDeliveryCapability,
  type DeliveryConnector,
  type DeliveryContentKind,
  type DeliveryTransformClass,
} from "./schema";
