const VAST_API = "https://console.vast.ai";

export async function vastFetch<T>(
  apiKey: string,
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${VAST_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Vast ${method} ${path} -> ${res.status}: ${text}`);
  }
  return text.length > 0 ? (JSON.parse(text) as T) : ({} as T);
}
