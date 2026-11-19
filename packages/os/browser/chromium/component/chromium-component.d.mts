export type ComponentAssets = Record<string, Buffer>;

export interface ChromiumPin {
  readonly revision: string;
  readonly source: string;
  readonly sha256: Readonly<Record<string, string>>;
}

export interface NativeHost {
  readonly application: string;
  readonly androidCertificates: readonly string[];
}

export interface ComponentReport {
  readonly chromiumRevision: string;
  readonly extensionId: string;
  readonly platform: "android";
  readonly nativeHost: NativeHost;
  readonly resources: Readonly<Record<string, { readonly bytes: number; readonly sha256: string }>>;
  readonly inputs: Readonly<Record<string, string>>;
  readonly outputs: Readonly<Record<string, string>>;
  readonly trustedActivityEmbedding: { readonly certificateSha256: string; readonly application: string } | null;
  readonly unrestrictedAllowlistBypass: false;
  readonly releaseBrowserBuildValidated: false;
  patchSha256?: string;
}

export interface ComponentOverlay {
  readonly files: Record<string, string | Buffer>;
  readonly report: ComponentReport;
}

export const pin: ChromiumPin;
export const EXTENSION_ID: string;
export const assetNames: readonly string[];
export const protectionAssetNames: readonly string[];
export function componentAssetNames(assets: ComponentAssets): readonly string[];
export function sha256(bytes: string | Uint8Array): string;
export function validateAssets(assets: ComponentAssets, certificate: string, application?: string): void;
export function generateComponentOverlay(request: {
  sources: Readonly<Record<string, string>>;
  assets: ComponentAssets;
  certificate: string;
  application?: string;
  embedHost?: boolean;
  revision: string;
}): Promise<ComponentOverlay>;
export function createComponentPatch(sources: Readonly<Record<string, string>>, files: Readonly<Record<string, string | Buffer>>): Promise<string>;
export function readReviewedChromiumSources(sourceRoot: string): Promise<{ sources: Record<string, string>; revision: string }>;
