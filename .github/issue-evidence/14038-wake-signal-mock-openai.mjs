/**
 * Minimal OpenAI-compatible mock provider for the wake-status probe.
 * Serves /v1/models, /v1/chat/completions (stream + non-stream, with
 * json_schema structured-output synthesis), /v1/embeddings and /v1/responses.
 * Purpose: give the booted agent a REAL registered TEXT handler + real
 * end-to-end replies with deterministic latency, no external keys.
 */
import http from "node:http";

const PORT = Number(process.env.MOCK_PORT ?? 18099);

/** Build a minimal instance of a JSON schema (fills required fields). */
function instantiate(schema, keyHint = "") {
  if (!schema || typeof schema !== "object") return "pong from mock";
  if (Array.isArray(schema.anyOf) && schema.anyOf.length)
    return instantiate(schema.anyOf[0], keyHint);
  if (Array.isArray(schema.oneOf) && schema.oneOf.length)
    return instantiate(schema.oneOf[0], keyHint);
  if (Array.isArray(schema.allOf) && schema.allOf.length)
    return instantiate(schema.allOf[0], keyHint);
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  if (schema.enum && Array.isArray(schema.enum) && schema.enum.length) {
    const pref = schema.enum.find(
      (v) =>
        typeof v === "string" &&
        /reply|simple|respond|message|none|chat|direct/i.test(v),
    );
    return pref ?? schema.enum[0];
  }
  if (schema.const !== undefined) return schema.const;
  switch (type) {
    case "object": {
      const out = {};
      const props = schema.properties ?? {};
      const req = new Set(schema.required ?? Object.keys(props));
      for (const [k, sub] of Object.entries(props)) {
        if (!req.has(k)) continue;
        out[k] = instantiate(sub, k);
      }
      return out;
    }
    case "array": {
      const min = schema.minItems ?? 0;
      if (min > 0) return [instantiate(schema.items ?? {}, keyHint)];
      return [];
    }
    case "string": {
      if (/message|text|reply|response|thought|answer|say/i.test(keyHint))
        return "pong from mock";
      if (/name|action|kind|type|route/i.test(keyHint)) return "REPLY";
      return "pong from mock";
    }
    case "number":
    case "integer":
      return 0;
    case "boolean":
      return false;
    case "null":
      return null;
    default:
      return "pong from mock";
  }
}

function lastUserText(messages) {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const c = m?.content;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) {
      const t = c
        .filter((p) => p?.type === "text")
        .map((p) => p.text)
        .join("\n");
      if (t) return t;
    }
  }
  return "";
}

function completionContent(body) {
  const schema = body?.response_format?.json_schema?.schema;
  if (schema) return JSON.stringify(instantiate(schema));
  const prompt = `${lastUserText(body?.messages)} ${body?.messages?.map((m) => (typeof m?.content === "string" ? m.content : "")).join(" ") ?? ""}`;
  // Legacy XML response-format prompts ask for a <response> block.
  if (/<response>/.test(prompt)) {
    return "<response><thought>ok</thought><actions>REPLY</actions><providers></providers><text>pong from mock</text><message>pong from mock</message></response>";
  }
  // shouldRespond-style gates often want RESPOND/IGNORE verdicts.
  if (/RESPOND\b[\s\S]*IGNORE\b/.test(prompt) && /should/i.test(prompt)) {
    return "<response><action>RESPOND</action><reasoning>probe</reasoning></response>";
  }
  return "pong from mock";
}

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  let body = null;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    body = null;
  }
  const url = req.url ?? "";

  if (req.method === "GET" && /\/models\/?$/.test(url.split("?")[0])) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        object: "list",
        data: [
          { id: "gpt-4o-mini", object: "model" },
          { id: "gpt-4o", object: "model" },
          { id: "gpt-5-mini", object: "model" },
          { id: "text-embedding-3-small", object: "model" },
        ],
      }),
    );
    return;
  }
  if (req.method === "POST" && url.includes("/embeddings")) {
    const input = Array.isArray(body?.input) ? body.input : [body?.input ?? ""];
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        object: "list",
        model: body?.model ?? "text-embedding-3-small",
        data: input.map((_, i) => ({
          object: "embedding",
          index: i,
          embedding: new Array(1536).fill(0.001),
        })),
        usage: { prompt_tokens: 1, total_tokens: 1 },
      }),
    );
    return;
  }
  if (
    req.method === "POST" &&
    (url.includes("/chat/completions") || url.includes("/completions"))
  ) {
    const content = completionContent(body);
    const model = body?.model ?? "gpt-4o-mini";
    if (body?.stream) {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      const id = "chatcmpl-mock";
      const mk = (delta, finish = null) =>
        `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      res.write(mk({ role: "assistant" }));
      res.write(mk({ content }));
      res.write(mk({}, "stop"));
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "chatcmpl-mock",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    );
    return;
  }
  if (req.method === "POST" && url.includes("/responses")) {
    // OpenAI Responses API shim (in case the SDK routes there).
    const content = completionContent(body);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "resp-mock",
        object: "response",
        status: "completed",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: content }],
          },
        ],
        output_text: content,
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    );
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[mock-openai] listening on 127.0.0.1:${PORT}`);
});
