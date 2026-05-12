export function jsonRequest(
  url: string,
  method: string,
  body?: unknown,
  headers: HeadersInit = {},
): Request {
  return new Request(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export function routeParams<T extends Record<string, string>>(params: T): { params: Promise<T> } {
  return { params: Promise.resolve(params) };
}

export async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

export function formDataRequest(url: string, formData: FormData) {
  return new Request(url, {
    method: "POST",
    body: formData,
  });
}

export function createFile(name: string, type: string, contents: string | Uint8Array = "test") {
  const data = typeof contents === "string" ? new TextEncoder().encode(contents) : contents;
  return new File([data as BlobPart], name, { type });
}
