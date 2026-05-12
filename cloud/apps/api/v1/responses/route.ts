import { type Context, Hono } from "hono";

import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { createPreflightResponse } from "@/lib/middleware/cors-apps";
import { enforceOrgRateLimit } from "@/lib/middleware/rate-limit";
import type { AppEnv } from "@/types/cloud-worker-env";
import { handleChatCompletionsPOST } from "../chat/completions/route";

type ResponseInputRole = "system" | "user" | "assistant" | "tool";

interface ResponseInputPart {
  type?: string;
  text?: string;
  input_text?: string;
  output_text?: string;
}

interface ResponseInputMessage {
  role?: ResponseInputRole;
  content?: string | ResponseInputPart[];
}

interface ResponsesRequest {
  model?: string;
  instructions?: string;
  input?: string | ResponseInputMessage[];
  temperature?: number;
  max_output_tokens?: number;
  max_tokens?: number;
  top_p?: number;
  stream?: boolean;
}

interface ChatCompletionPayload {
  id?: string;
  model?: string;
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

const app = new Hono<AppEnv>();

function jsonError(message: string, status = 400, code = "invalid_request_error") {
  return Response.json(
    {
      error: {
        message,
        type: "invalid_request_error",
        code,
      },
    },
    { status },
  );
}

function extractPartText(part: ResponseInputPart): string {
  return part.text ?? part.input_text ?? part.output_text ?? "";
}

function extractContentText(content: string | ResponseInputPart[] | undefined): string {
  if (typeof content === "string") {
    return content.trim();
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content.map(extractPartText).filter(Boolean).join("\n").trim();
}

function normalizeRole(role: ResponseInputRole | undefined): ResponseInputRole {
  if (role === "system" || role === "assistant" || role === "tool") {
    return role;
  }
  return "user";
}

function toChatMessages(body: ResponsesRequest) {
  const messages: Array<{ role: ResponseInputRole; content: string }> = [];
  const instructions = body.instructions?.trim();

  if (instructions) {
    messages.push({ role: "system", content: instructions });
  }

  if (typeof body.input === "string") {
    const content = body.input.trim();
    if (content) {
      messages.push({ role: "user", content });
    }
    return messages;
  }

  if (Array.isArray(body.input)) {
    for (const item of body.input) {
      const content = extractContentText(item.content);
      if (content) {
        messages.push({ role: normalizeRole(item.role), content });
      }
    }
  }

  return messages;
}

function mapChatCompletionToResponse(payload: ChatCompletionPayload, requestedModel: string) {
  const text = payload.choices?.[0]?.message?.content?.trim() ?? "";
  const responseId = payload.id?.startsWith("resp_") ? payload.id : `resp_${crypto.randomUUID()}`;
  const createdAt = Math.floor(Date.now() / 1000);
  const promptTokens = payload.usage?.prompt_tokens ?? 0;
  const completionTokens = payload.usage?.completion_tokens ?? 0;
  const totalTokens = payload.usage?.total_tokens ?? promptTokens + completionTokens;

  return {
    id: responseId,
    object: "response",
    created_at: createdAt,
    model: payload.model ?? requestedModel,
    status: "completed",
    output: [
      {
        id: `msg_${crypto.randomUUID()}`,
        type: "message",
        status: "completed",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text,
          },
        ],
      },
    ],
    output_text: text,
    usage: {
      input_tokens: promptTokens,
      output_tokens: completionTokens,
      total_tokens: totalTokens,
    },
  };
}

async function parseResponsesRequest(c: Context<AppEnv>) {
  try {
    return (await c.req.json()) as ResponsesRequest;
  } catch {
    return null;
  }
}

function buildChatRequest(
  original: Request,
  body: ResponsesRequest,
  messages: ReturnType<typeof toChatMessages>,
) {
  const headers = new Headers(original.headers);
  headers.set("Content-Type", "application/json");
  headers.delete("Content-Length");

  return new Request(original.url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: body.model,
      messages,
      temperature: body.temperature,
      max_tokens: body.max_output_tokens ?? body.max_tokens,
      top_p: body.top_p,
      stream: false,
    }),
    signal: original.signal,
  });
}

app.options("/", (c) =>
  createPreflightResponse(c.req.header("origin") ?? null, ["POST", "OPTIONS"]),
);

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    if (user.organization_id) {
      const rateLimited = await enforceOrgRateLimit(user.organization_id, "completions");
      if (rateLimited) return rateLimited;
    }

    const body = await parseResponsesRequest(c);
    if (!body) {
      return jsonError("Request body must be valid JSON");
    }

    if (!body.model?.trim()) {
      return jsonError("Missing required field: model", 400, "missing_required_parameter");
    }

    if (body.stream === true) {
      return jsonError(
        "Streaming is not supported on /api/v1/responses. Use /api/v1/chat/completions for streaming.",
      );
    }

    const messages = toChatMessages(body);
    if (messages.length === 0) {
      return jsonError("Missing required field: input", 400, "missing_required_parameter");
    }

    const chatRequest = buildChatRequest(c.req.raw, body, messages);
    const chatResponse = await handleChatCompletionsPOST(chatRequest, {
      skipOrgRateLimit: true,
    });

    if (!chatResponse.ok) {
      return chatResponse;
    }

    const payload = (await chatResponse.json()) as ChatCompletionPayload;
    return c.json(mapChatCompletionToResponse(payload, body.model.trim()));
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
