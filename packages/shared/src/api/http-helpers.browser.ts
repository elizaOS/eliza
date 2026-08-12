/**
 * Browser-safe facade for shared HTTP helpers (#18056).
 *
 * Node/API code must use `http-helpers.ts` (re-export of `@elizaos/core`).
 * The app Vite config aliases this module in for renderer builds so bare core
 * is never pulled into cold `/login`.
 */

export type ReadJsonBodyOptions = {
  maxBytes?: number;
  encoding?: BufferEncoding;
  tooLargeMessage?: string;
  returnNullOnError?: boolean;
  returnNullOnTooLarge?: boolean;
  destroyOnTooLarge?: boolean;
};

export type RequestBodyOptions = ReadJsonBodyOptions;

export const DEFAULT_MAX_BODY_BYTES = 1_048_576;

function browserUnavailable(name: string): never {
  throw new Error(
    `@elizaos/shared ${name} is only available in Node/API runtimes`,
  );
}

export async function readRequestBodyBuffer(
  ..._args: unknown[]
): Promise<Buffer | null> {
  return browserUnavailable("readRequestBodyBuffer");
}

export async function readRequestBody(
  ..._args: unknown[]
): Promise<string | null> {
  return browserUnavailable("readRequestBody");
}

export async function readJsonBody<T = Record<string, unknown>>(
  ..._args: unknown[]
): Promise<T | null> {
  return browserUnavailable("readJsonBody");
}

export function sendJson(
  _res: unknown,
  _status: number,
  _body: unknown,
): void {
  browserUnavailable("sendJson");
}

export function sendJsonError(
  _res: unknown,
  _status: number,
  _message: string,
): void {
  browserUnavailable("sendJsonError");
}
