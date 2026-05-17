import type { AppRunSummary, AppViewerAuthMessage } from "../../api/client-types-cloud";
export declare function resolveEmbeddedViewerUrl(viewerUrl: string): string;
export declare function resolvePostMessageTargetOrigin(viewerUrl: string): string;
export declare function resolveViewerReadyEventType(payload: AppViewerAuthMessage | null | undefined): string | null;
export declare function buildViewerSessionKey(viewerUrl: string, payload: AppViewerAuthMessage | null | undefined): string;
export declare function shouldUseEmbeddedAppViewer(run: AppRunSummary | null | undefined): boolean;
//# sourceMappingURL=viewer-auth.d.ts.map