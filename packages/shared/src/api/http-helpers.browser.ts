/**
 * Browser-only facade for shared HTTP helpers (#18056).
 *
 * Selected exclusively by the app Vite alias — never the default Node export.
 * Signatures match `@elizaos/core` so typecheck of renderer graphs stays honest;
 * every call throws because these APIs require `node:http`.
 */

export type RequestBodyOptions = {
  maxBytes?: number;
  encoding?: BufferEncoding;
  tooLargeMessage?: string;
  returnNullOnError?: boolean;
  returnNullOnTooLarge?: boolean;
  destroyOnTooLarge?: boolean;
};

export type ReadJsonBodyOptions = RequestBodyOptions & {
  requireObject?: boolean;
  readErrorStatus?: number;
  nonObjectStatus?: number;
  parseErrorStatus?: number;
  readErrorMessage?: string;
  nonObjectMessage?: string;
  parseErrorMessage?: string;
};

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

/** Matches core: `(res, body, status?)`. */
export function sendJson(
  _res: unknown,
  _body: unknown,
  _status = 200,
): void {
  browserUnavailable("sendJson");
}

/** Matches core: `(res, message, status?)`. */
export function sendJsonError(
  _res: unknown,
  _message: string,
  _status = 400,
): void {
  browserUnavailable("sendJsonError");
}
