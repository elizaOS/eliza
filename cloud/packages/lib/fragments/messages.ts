import type { DeepPartial } from "ai";
import type { FragmentSchema } from "./schema";
import type { ExecutionResult } from "./types";

export type MessageText = {
  type: "text";
  text: string;
};

export type MessageCode = {
  type: "code";
  text: string;
};

export type MessageImage = {
  type: "image";
  image: string;
};

export type Message = {
  role: "assistant" | "user";
  content: Array<MessageText | MessageCode | MessageImage>;
  object?: DeepPartial<FragmentSchema>;
  result?: ExecutionResult;
};

export function toAISDKMessages(messages: Message[]) {
  return messages.map((message) => ({
    role: message.role,
    content: message.content.map((content) => {
      if (content.type === "code") {
        return {
          type: "text",
          text: content.text,
        };
      }

      return content;
    }),
  }));
}

export async function toMessageImage(files: File[]): Promise<string[]> {
  if (files.length === 0) {
    return [];
  }

  return Promise.all(
    files.map(async (file) => {
      const arrayBuffer = await file.arrayBuffer();
      const base64 = Buffer.from(arrayBuffer).toString("base64");
      return `data:${file.type};base64,${base64}`;
    }),
  );
}
