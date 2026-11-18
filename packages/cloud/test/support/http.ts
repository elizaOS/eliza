// spec/cloud/deployment.md, "Story: Answer only the deployment's own callers"
import { request as httpRequest } from "node:http";

export interface Answer {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

export interface CallInit {
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly json?: unknown;
  readonly form?: FormData;
}

export async function callCloud(base: string, path: string, init: CallInit = {}): Promise<Answer> {
  const response = await fetch(new URL(path, base), {
    method: init.method ?? (init.json === undefined && init.form === undefined ? "GET" : "POST"),
    headers: { ...(init.json === undefined ? {} : { "content-type": "application/json" }), ...init.headers },
    body: init.form ?? (init.json === undefined ? undefined : JSON.stringify(init.json)),
  });
  const text = await response.text();
  const type = response.headers.get("content-type") ?? "";
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body: type.includes("json") && text !== "" ? (JSON.parse(text) as unknown) : text,
  };
}

export function callDeclaring(base: string, path: string, declaredBytes: number, headers: Readonly<Record<string, string>> = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(new URL(path, base), { method: "POST", headers: { ...headers, "content-length": String(declaredBytes) } }, (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.on("end", () => {
        outgoing.destroy();
        const text = Buffer.concat(chunks).toString("utf8");
        const flat = Object.fromEntries(Object.entries(incoming.headers).map(([name, value]) => [name, String(value)]));
        resolve({ status: incoming.statusCode ?? 0, headers: flat, body: text === "" ? text : (JSON.parse(text) as unknown) });
      });
    });
    outgoing.on("error", reject);
    outgoing.flushHeaders();
  });
}
