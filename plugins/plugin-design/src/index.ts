/** Public surface of the design domain plugin and its provider adapters. */

export type { DesignProviderAdapter } from "./adapter.js";
export {
  CANVA_API_ORIGIN,
  CANVA_PROVIDER_ID,
  CanvaDesignAdapter,
  type CanvaDesignAdapterOptions,
} from "./canva.js";
export { DesignError, type DesignErrorCode } from "./errors.js";
export {
  FIGMA_API_ORIGIN,
  FIGMA_PROVIDER_ID,
  FigmaDesignAdapter,
  type FigmaDesignAdapterOptions,
} from "./figma.js";
export { default, designPlugin } from "./plugin.js";
export {
  DESIGN_SERVICE_TYPE,
  DesignService,
  MANAGED_DESIGN_ELIGIBILITY,
  type ManagedDesignEligibility,
  type ManagedDesignProvider,
} from "./service.js";
export type {
  DesignCapability,
  DesignComment,
  DesignCommentPage,
  DesignExportArtifact,
  DesignExportFormat,
  DesignExportRequest,
  DesignPage,
  DesignRef,
  DesignSearchRequest,
} from "./types.js";
export {
  designCommentPageSchema,
  designExportArtifactSchema,
  designExportRequestSchema,
  designPageSchema,
  designRefSchema,
  designSearchRequestSchema,
} from "./types.js";
