// spec/cloud/deployment.md, "Story: Answer only the deployment's own callers"
export interface Answer {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

export interface CallInit {
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly json?: unknown;
}

export async function callCloud(base: string, path: string, init: CallInit = {}): Promise<Answer> {
  const response = await fetch(new URL(path, base), {
    method: init.method ?? (init.json === undefined ? "GET" : "POST"),
    headers: { ...(init.json === undefined ? {} : { "content-type": "application/json" }), ...init.headers },
    body: init.json === undefined ? undefined : JSON.stringify(init.json),
  });
  const text = await response.text();
  const type = response.headers.get("content-type") ?? "";
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body: type.includes("json") && text !== "" ? (JSON.parse(text) as unknown) : text,
  };
}
