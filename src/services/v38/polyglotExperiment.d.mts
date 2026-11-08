export interface PolyglotOptions { enabled: boolean; inputIsPublic: boolean; timeoutMs?: number; fetcher?: typeof fetch; }
export const POLYGLOT_SECURITY_NOTICE: string;
export function generatePolyglotSignature(seedWords: readonly string[], options?: PolyglotOptions): Promise<readonly string[]>;
