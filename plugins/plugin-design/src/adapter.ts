/**
 * Provider seam for the design domain. Adapters declare their supported
 * capabilities so deterministic code — never prompt text — selects behavior,
 * and expose only an opaque connection handle instead of credentials.
 */

import type {
  DesignCapability,
  DesignCommentPage,
  DesignExportArtifact,
  DesignExportRequest,
  DesignPage,
  DesignRef,
  DesignSearchRequest,
} from "./types.js";

export interface DesignProviderAdapter {
  readonly id: string;
  readonly connectionId: string;
  readonly capabilities: ReadonlySet<DesignCapability>;
  searchDesigns(request: DesignSearchRequest): Promise<DesignPage>;
  getDesign(providerDesignId: string): Promise<DesignRef | null>;
  exportDesign(request: DesignExportRequest): Promise<DesignExportArtifact>;
  listComments(
    providerDesignId: string,
    cursor?: string,
  ): Promise<DesignCommentPage>;
}
