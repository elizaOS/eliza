import { describe, expect, it } from "vitest";
import { projectVoiceOutput } from "./voice-output-envelope";

describe("voice output envelope", () => {
  it("keeps exact structured display while speaking a safe concise summary", () => {
    const markdown = [
      "Run this:",
      "```ts",
      "const url = 'https://example.test/private/path';",
      "```",
      "| Result | Count |",
      "| --- | ---: |",
      "| ready | 2 |",
    ].join("\n");
    const result = projectVoiceOutput({
      policy: "both",
      display: { markdown },
    });

    expect(result.displayMarkdown).toBe(markdown);
    expect(result.speechText).toBe(
      "I've put the exact structured details on screen.",
    );
    expect(result.captions).toBe(result.speechText);
    expect(result.usedStructuredSummary).toBe(true);
    expect(result.speechText).not.toContain("https://");
    expect(result.speechText).not.toContain("const url");
  });

  it("uses explicit spoken prose while preserving exact display and artifacts", () => {
    const artifacts = [
      { id: "artifact-1", kind: "file" as const, label: "full report" },
    ];
    const result = projectVoiceOutput({
      policy: "both",
      display: { markdown: "**42** records. See `/tmp/report.json`." },
      spoken: "I found 42 records and attached the full report.",
      artifacts,
    });

    expect(result.speechText).toBe(
      "I found 42 records and attached the full report.",
    );
    expect(result.captions).toBe(result.speechText);
    expect(result.artifacts).toEqual(artifacts);
    expect(result.displayMarkdown).toBe(
      "**42** records. See `/tmp/report.json`.",
    );
  });

  it.each(["show", "never_speak"] as const)(
    "%s policy never reaches TTS",
    (policy) => {
      const result = projectVoiceOutput({
        policy,
        display: { markdown: "Exact on-screen answer" },
        spoken: "Do not synthesize this",
      });
      expect(result.speechText).toBeNull();
      expect(result.captions).toBeNull();
    },
  );

  it("requires explicit speech for say-only structured content", () => {
    const result = projectVoiceOutput({
      policy: "say",
      display: { markdown: "Run `bun test` now." },
    });
    expect(result.showDisplay).toBe(false);
    expect(result.speechText).toBeNull();
    expect(result.speechBlockReason).toBe("structured_requires_spoken");
  });

  it.each([
    "const hidden = 1; console.log(hidden);",
    "Name | Value\n--- | ---\nprivate | 1",
    "Open src/private/keys.txt",
  ])("blocks structured explicit speech: %s", (spoken) => {
    const result = projectVoiceOutput({
      policy: "both",
      display: { markdown: "A safe visual summary." },
      spoken,
    });
    expect(result.speechText).toBeNull();
    expect(result.speechBlockReason).toBe("structured_speech");
  });

  it.each([
    "I fixed the type mismatch.",
    "The function works now.",
    "I updated the class schedule.",
    "I can import records now.",
    "Let me export the report.",
    "The interface looks good.",
  ])("allows benign technical prose: %s", (spoken) => {
    expect(
      projectVoiceOutput({
        policy: "say",
        display: { markdown: "" },
        spoken,
      }).speechText,
    ).toBe(spoken);
  });

  it.each([
    "Choose yes/no for now.",
    "You can use either and/or both.",
    "Select one option from the list.",
    "The AC/DC adapter works.",
    "The ratio is one/two.",
  ])("allows benign prose containing a slash: %s", (spoken) => {
    expect(
      projectVoiceOutput({
        policy: "say",
        display: { markdown: "" },
        spoken,
      }).speechText,
    ).toBe(spoken);
  });

  it("blocks token-like or private-key material instead of sanitizing it into speech", () => {
    for (const spoken of [
      "Bearer abcdefghijklmnopqrstuvwxyz123456",
      "api_key=abcdefghijklmnop123456",
      "-----BEGIN PRIVATE KEY----- secret -----END PRIVATE KEY-----",
    ]) {
      const result = projectVoiceOutput({
        policy: "both",
        display: { markdown: "Sensitive output remains visual." },
        spoken,
      });
      expect(result.speechText).toBeNull();
      expect(result.speechBlockReason).toBe("sensitive_content");
    }
  });

  it("blocks normalized and format-character-split provider credential shapes", () => {
    const fakeSecrets = [
      `ｓｋ＿ｃａｒ＿${"Ａ".repeat(24)}`,
      `sk\u200b_car_${"B".repeat(24)}`,
      `csk-${"C".repeat(24)}`,
      `ghp_${"D".repeat(32)}`,
      `AIza${"E".repeat(35)}`,
      `Basic ${"RkFLRUJBU0U2NA==".repeat(2)}`,
      `password=${"F".repeat(24)}`,
    ];
    for (const spoken of fakeSecrets) {
      expect(
        projectVoiceOutput({
          policy: "both",
          display: { markdown: "Credential details" },
          spoken,
        }).speechBlockReason,
      ).toBe("sensitive_content");
    }
  });

  it("does not block benign security prose or safe speech paired with sensitive display", () => {
    expect(
      projectVoiceOutput({
        policy: "say",
        display: { markdown: "" },
        spoken: "A password policy and API key rotation plan are ready.",
      }).speechText,
    ).toBe("A password policy and API key rotation plan are ready.");

    const result = projectVoiceOutput({
      policy: "both",
      display: { markdown: `api_key=${"G".repeat(24)}` },
      spoken: "I put the sensitive value on screen without reading it aloud.",
    });
    expect(result.speechText).toBe(
      "I put the sensitive value on screen without reading it aloud.",
    );
  });

  it.each([
    ["relative path", "Open src/private/keys.txt"],
    ["dot path", "Open ./private/keys.txt"],
    ["home path", "Open ~/private/keys.txt"],
    ["unclosed fence", "```ts\nconst hidden = true;"],
    ["tilde fence", '~~~json\n{"hidden":true}'],
    ["indented code", "Instructions:\n    const hidden = true;"],
    ["HTML code", "<pre>private details</pre>"],
    ["unfenced code", "const hidden = 1; console.log(hidden);"],
    ["SQL", "SELECT secret FROM private_table;"],
    ["SQL without terminator", "SELECT secret FROM private_table"],
    ["shell", "curl https://private.example.test/data"],
    ["GFM table", "Name | Count\n--- | ---:\nready | 2"],
    ["reference link", "Read [the guide][guide]\n[guide]: /private"],
  ])("summarizes %s instead of speaking its payload", (_name, markdown) => {
    const result = projectVoiceOutput({
      policy: "both",
      display: { markdown },
    });
    expect(result.usedStructuredSummary).toBe(true);
    expect(result.speechText).toContain("screen");
    expect(result.speechText).not.toContain("private");
  });

  it("caps speech at a stable boundary and keeps captions byte-equal", () => {
    const result = projectVoiceOutput(
      {
        policy: "say",
        display: { markdown: "" },
        spoken:
          "First useful sentence is complete. Second sentence contains many extra words that should not all be synthesized for this bounded projection.",
      },
      { maxSpeechChars: 52 },
    );
    expect(result.speechText).toBe("First useful sentence is complete.…");
    expect(result.captions).toBe(result.speechText);
    expect(result.showDisplay).toBe(false);
    expect(result.truncated).toBe(true);
    expect(result.speechText?.length).toBeLessThanOrEqual(52);
  });

  it("enforces the hard minimum cap without overflowing for unbroken text", () => {
    const result = projectVoiceOutput(
      {
        policy: "say",
        display: { markdown: "" },
        spoken: "A".repeat(100),
      },
      { maxSpeechChars: 40 },
    );
    expect(result.speechText).toHaveLength(40);
    expect(result.speechText?.endsWith("…")).toBe(true);
  });

  it("does not split a non-BMP letter at the speech boundary", () => {
    const result = projectVoiceOutput(
      {
        policy: "say",
        display: { markdown: "" },
        spoken: "𐐀".repeat(30),
      },
      { maxSpeechChars: 40 },
    );
    expect(result.speechText?.length).toBeLessThanOrEqual(40);
    expect(result.speechText).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(result.speechText).not.toMatch(
      /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
    );
  });

  it("filters invalid artifact references without mutating valid ones", () => {
    const result = projectVoiceOutput({
      policy: "both",
      display: { markdown: "Done." },
      artifacts: [
        { id: "", kind: "file", label: "missing id" },
        {
          id: "unsafe",
          kind: "link",
          label: "unsafe link",
          href: "javascript:alert(1)",
        },
        {
          id: "protocol-relative",
          kind: "link",
          label: "unsafe origin",
          href: "//evil.example.test/result",
        },
        {
          id: "control-char",
          kind: "link",
          label: "unsafe control",
          href: "/safe\nunsafe",
        },
        {
          id: "backslash-origin",
          kind: "link",
          label: "unsafe origin",
          href: "/\\evil.example.test/result",
        },
        { id: "ok", kind: "link", label: "result", href: "/result" },
      ],
    });
    expect(result.artifacts).toEqual([
      { id: "ok", kind: "link", label: "result", href: "/result" },
    ]);
  });

  it("copies and freezes validated artifacts before returning them", () => {
    const artifact = {
      id: "safe-link",
      kind: "link" as const,
      label: "Safe link",
      href: "/safe",
    };
    const projection = projectVoiceOutput({
      policy: "both",
      display: { markdown: "Safe answer." },
      artifacts: [artifact],
    });

    artifact.href = "javascript:alert(1)";
    expect(projection.artifacts).toEqual([
      {
        id: "safe-link",
        kind: "link",
        label: "Safe link",
        href: "/safe",
      },
    ]);
    expect(Object.isFrozen(projection.artifacts)).toBe(true);
    expect(Object.isFrozen(projection.artifacts[0])).toBe(true);
  });

  it("fails closed for malformed runtime envelopes and artifacts", () => {
    const malformed = {
      policy: "both",
      display: null,
      artifacts: [null, { id: 42, label: "bad", kind: "file" }],
    } as unknown as Parameters<typeof projectVoiceOutput>[0];
    expect(() => projectVoiceOutput(malformed)).not.toThrow();
    expect(projectVoiceOutput(malformed)).toMatchObject({
      speechText: null,
      speechBlockReason: "invalid_envelope",
      artifacts: [],
    });

    const malformedSpoken = {
      policy: "both",
      display: { markdown: "Safe display" },
      spoken: 42,
    } as unknown as Parameters<typeof projectVoiceOutput>[0];
    expect(() => projectVoiceOutput(malformedSpoken)).not.toThrow();
    expect(projectVoiceOutput(malformedSpoken).speechBlockReason).toBe(
      "invalid_envelope",
    );
  });
});
