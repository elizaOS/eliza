export interface CapacitorHttpRequestOptions {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  data: unknown;
  responseType: "arraybuffer";
  connectTimeout: number;
  readTimeout: number;
}

export type CapacitorHttpRequest = (
  options: CapacitorHttpRequestOptions,
) => Promise<{ status: number; data?: unknown }>;

function decodeBase64Bytes(value: unknown): Uint8Array {
  if (typeof value !== "string" || value.length === 0) return new Uint8Array();
  const binary = globalThis.atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/** Native HTTP is only safe for remote HTTPS routes, never local-agent IPC. */
export function isCapacitorHttpAudioUrl(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

/** Request audio through Capacitor without the patched fetch text round-trip. */
export async function requestCapacitorAudio(
  request: CapacitorHttpRequest,
  url: string,
  data: unknown,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<{ status: number; bytes: Uint8Array }> {
  const response = await request({
    url,
    method: "POST",
    headers: {
      Accept: "audio/wav, audio/mpeg, audio/*;q=0.9",
      "Content-Type": "application/json",
      ...headers,
    },
    data,
    responseType: "arraybuffer",
    connectTimeout: timeoutMs,
    readTimeout: timeoutMs,
  });

  return {
    status: response.status,
    bytes: decodeBase64Bytes(response.data),
  };
}
