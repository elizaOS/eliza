/** Verifies chat payload parsing honors the UI language headers the client sends when the body carries no `language`. */
import type http from "node:http";
import { describe, expect, it } from "vitest";
import { readChatRequestPayload } from "../src/api/chat-routes.ts";

function requestWithHeaders(
  headers: http.IncomingHttpHeaders,
): http.IncomingMessage {
  return { headers } as http.IncomingMessage;
}

async function parse(
  headers: http.IncomingHttpHeaders,
  body: Record<string, unknown> = { text: "hola" },
) {
  const errors: string[] = [];
  const payload = await readChatRequestPayload(
    requestWithHeaders(headers),
    {} as http.ServerResponse,
    {
      readJsonBody: async <T extends object>() => body as T,
      error: (_res, message) => {
        errors.push(message);
      },
    },
  );
  expect(errors).toEqual([]);
  return payload;
}

describe("readChatRequestPayload UI language", () => {
  it.each(["ja", "ja-JP", "JA-jp"])(
    "keeps Japanese from the client header or explicit body (%s)",
    async (language) => {
      expect(
        (await parse({ "x-elizaos-ui-language": language }))?.preferredLanguage,
      ).toBe("ja");
      expect(
        (
          await parse(
            { "x-elizaos-ui-language": "en" },
            { text: "こんにちは", language },
          )
        )?.preferredLanguage,
      ).toBe("ja");
    },
  );

  it("reads the X-ElizaOS-UI-Language header sent by the UI client", async () => {
    const payload = await parse({ "x-elizaos-ui-language": "es" });
    expect(payload?.preferredLanguage).toBe("es");
  });

  it("still accepts the legacy X-Eliza-UI-Language header", async () => {
    const payload = await parse({ "x-eliza-ui-language": "ko" });
    expect(payload?.preferredLanguage).toBe("ko");
  });

  it("prefers X-ElizaOS-UI-Language over the legacy header", async () => {
    const payload = await parse({
      "x-elizaos-ui-language": "es",
      "x-eliza-ui-language": "ko",
    });
    expect(payload?.preferredLanguage).toBe("es");
  });

  it("prefers an explicit body language over headers", async () => {
    const payload = await parse(
      { "x-elizaos-ui-language": "es" },
      { text: "hi", language: "vi" },
    );
    expect(payload?.preferredLanguage).toBe("vi");
  });

  it("omits preferredLanguage when no language is supplied", async () => {
    const payload = await parse({});
    expect(payload).not.toHaveProperty("preferredLanguage");
  });
});
