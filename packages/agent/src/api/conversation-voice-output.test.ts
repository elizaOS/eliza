import { describe, expect, it } from "vitest";

import { buildTerminalVoiceOutput } from "./conversation-routes.ts";

describe("conversation terminal voice artifacts", () => {
  it("projects safe references without carrying inline bytes", () => {
    const output = buildTerminalVoiceOutput({
      text: "I made the files.",
      attachments: [
        {
          id: "image-1",
          url: "/api/media/image-1.png",
          title: "Preview",
          contentType: "image",
          mimeType: "image/png",
        },
        {
          id: "inline-audio",
          url: "data:audio/wav;base64,UklGRg==",
          title: "Inline bytes",
          contentType: "audio",
        },
        {
          id: "report-1",
          url: "https://example.test/report.json",
          title: "Report",
          contentType: "document",
          mimeType: "application/json",
        },
      ],
    });

    expect(output).toEqual({
      policy: "both",
      artifacts: [
        {
          id: "image-1",
          kind: "image",
          label: "Preview",
          mimeType: "image/png",
          href: "/api/media/image-1.png",
        },
        {
          id: "report-1",
          kind: "data",
          label: "Report",
          mimeType: "application/json",
          href: "https://example.test/report.json",
        },
      ],
    });
    expect(JSON.stringify(output)).not.toContain("UklGRg");
  });

  it("omits malformed, executable, and overlong references", () => {
    expect(
      buildTerminalVoiceOutput({
        attachments: [
          {
            id: "bad id",
            url: "javascript:alert(1)",
            title: "Bad",
          },
        ],
      }),
    ).toBeUndefined();
  });
});
