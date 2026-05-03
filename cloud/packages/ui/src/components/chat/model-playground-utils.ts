export interface PlaygroundMessageInput {
  role: "user" | "assistant";
  content: string;
}

export interface PlaygroundUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }

      if (!isRecord(part)) {
        return "";
      }

      if (typeof part.text === "string") {
        return part.text;
      }

      return "";
    })
    .filter((value) => value.length > 0)
    .join("\n")
    .trim();
}

export function buildResponsesInput(messages: PlaygroundMessageInput[]) {
  return messages.map((message) => ({
    role: message.role,
    content: message.content,
  }));
}

export function extractPlaygroundResponseText(payload: unknown): string {
  if (!isRecord(payload)) {
    return "";
  }

  if (typeof payload.output_text === "string" && payload.output_text.trim().length > 0) {
    return payload.output_text.trim();
  }

  if (Array.isArray(payload.output)) {
    const text = payload.output
      .map((item) => {
        if (!isRecord(item) || item.type !== "message") {
          return "";
        }

        return extractTextContent(item.content);
      })
      .filter((value) => value.length > 0)
      .join("\n\n")
      .trim();

    if (text.length > 0) {
      return text;
    }
  }

  if (Array.isArray(payload.choices)) {
    const firstChoice = payload.choices[0];
    if (isRecord(firstChoice) && isRecord(firstChoice.message)) {
      return extractTextContent(firstChoice.message.content);
    }
  }

  return "";
}

export function extractPlaygroundUsage(payload: unknown): PlaygroundUsage | null {
  if (!isRecord(payload) || !isRecord(payload.usage)) {
    return null;
  }

  const usage = payload.usage;

  const inputTokens =
    typeof usage.input_tokens === "number"
      ? usage.input_tokens
      : typeof usage.prompt_tokens === "number"
        ? usage.prompt_tokens
        : 0;
  const outputTokens =
    typeof usage.output_tokens === "number"
      ? usage.output_tokens
      : typeof usage.completion_tokens === "number"
        ? usage.completion_tokens
        : 0;
  const totalTokens =
    typeof usage.total_tokens === "number" ? usage.total_tokens : inputTokens + outputTokens;

  if (inputTokens === 0 && outputTokens === 0 && totalTokens === 0) {
    return null;
  }

  return {
    inputTokens,
    outputTokens,
    totalTokens,
  };
}

export function extractPlaygroundErrorMessage(payload: unknown, status?: number): string {
  if (isRecord(payload)) {
    if (isRecord(payload.error) && typeof payload.error.message === "string") {
      return payload.error.message;
    }

    if (typeof payload.message === "string" && payload.message.length > 0) {
      return payload.message;
    }
  }

  if (status === 401) {
    return "Please log in before testing this model.";
  }

  if (status === 402) {
    return "This request could not run because the account does not have enough credits.";
  }

  if (status && status >= 500) {
    return "The model request failed on the server. Please try again.";
  }

  return "The model request failed. Please try again.";
}
