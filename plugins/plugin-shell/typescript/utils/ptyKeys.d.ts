/**
 * PTY Key Encoding - Terminal key sequence encoding utilities
 * Ported from otto pty-keys.ts and pty-dsr.ts
 */
export declare const BRACKETED_PASTE_START = "\u001B[200~";
export declare const BRACKETED_PASTE_END = "\u001B[201~";
export type KeyEncodingRequest = {
  keys?: string[];
  hex?: string[];
  literal?: string;
};
export type KeyEncodingResult = {
  data: string;
  warnings: string[];
};
export declare function encodeKeySequence(request: KeyEncodingRequest): KeyEncodingResult;
export declare function encodePaste(text: string, bracketed?: boolean): string;
export declare function stripDsrRequests(input: string): {
  cleaned: string;
  requests: number;
};
export declare function buildCursorPositionResponse(row?: number, col?: number): string;
