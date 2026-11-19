export interface ReviewedChromium {
  readonly revision: string;
  readonly source: string;
  readonly sha256: Readonly<Record<string, string>>;
}

export interface ComponentReport {
  readonly chromiumRevision: string;
  readonly extensionId: string;
  readonly platform: "android";
  readonly nativeHost: { readonly application: string; readonly androidCertificates: readonly string[] };
  readonly resources: Readonly<Record<string, { readonly bytes: number; readonly sha256: string }>>;
  readonly inputs: Readonly<Record<string, string>>;
  readonly outputs: Readonly<Record<string, string>>;
  readonly trustedActivityEmbedding: { readonly certificateSha256: string; readonly application: string } | null;
  readonly unrestrictedAllowlistBypass: false;
  readonly releaseBrowserBuildValidated: false;
}

export const pin: ReviewedChromium;
export const EXTENSION_ID: string;
export const assetNames: readonly string[];
export const protectionAssetNames: readonly string[];

/** @throws {never} */
export function componentAssetNames(assets: object): readonly string[];
/** @throws {never} */
export function sha256(bytes: string | Uint8Array): string;
/** @throws {Error} when the resource inventory, manifest or native host configuration is not the reviewed one */
export function validateAssets(assets: Readonly<Record<string, Uint8Array>>, certificate: string, application?: string): void;
export function generateComponentOverlay(options: {
  readonly sources: Readonly<Record<string, Uint8Array | string>>;
  readonly assets: Readonly<Record<string, Uint8Array>>;
  readonly certificate: string;
  readonly application?: string;
  readonly embedHost?: boolean;
  readonly revision: string;
}): Promise<{ readonly files: Record<string, string | Uint8Array>; readonly report: ComponentReport }>;
export function createComponentPatch(sources: Readonly<Record<string, Uint8Array | string>>, files: Readonly<Record<string, string | Uint8Array>>): Promise<string>;
export function readReviewedChromiumSources(sourceRoot: string): Promise<{ readonly sources: Record<string, Uint8Array>; readonly revision: string }>;
