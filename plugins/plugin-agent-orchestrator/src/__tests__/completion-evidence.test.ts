/**
 * Renderer pins for the completion-evidence bundle, centered on the
 * claims-vs-proof stance: probe-verified URLs vs mentioned URLs, and (#16523)
 * ledger-verified files vs unverified file claims. The judge only ever sees
 * the serialized string, so the section wording IS the contract.
 */
import { describe, expect, it } from "vitest";
import {
  appendCompletionEvidenceSection,
  buildCompletionEvidenceString,
  type CompletionEvidenceBundle,
  extractChildToolTrace,
} from "../services/completion-evidence.js";

function bundle(
  overrides: Partial<CompletionEvidenceBundle>,
): CompletionEvidenceBundle {
  return {
    summary: "did the thing",
    verifiedUrls: [],
    screenshots: [],
    ...overrides,
  };
}

describe("buildCompletionEvidenceString — unverified file claims (#16523)", () => {
  it("renders each unverified claim with its fail-closed reason", () => {
    const rendered = buildCompletionEvidenceString(
      bundle({
        unverifiedClaimedFiles: [
          { path: "src/phantom.ts", reason: "rejected-write" },
          { path: "src/invented.ts", reason: "no-write-observed" },
        ],
      }),
    );
    expect(rendered).toContain("## UNVERIFIED FILE CLAIMS");
    expect(rendered).toContain(
      "- src/phantom.ts (the tool layer REJECTED this write)",
    );
    expect(rendered).toContain(
      "- src/invented.ts (no successful write observed)",
    );
    // Explicit relay stance: the header tells the judge how to treat them.
    expect(rendered).toContain("treat each as NOT delivered");
  });

  it("renders no file-claims section when every claim is ledger-verified", () => {
    const rendered = buildCompletionEvidenceString(
      bundle({
        ledgerVerifiedFiles: ["src/good.ts"],
        unverifiedClaimedFiles: [],
      }),
    );
    expect(rendered).not.toContain("UNVERIFIED FILE CLAIMS");
  });

  it("the flag survives the thin-completion fallback — fail-closed relay", () => {
    // With ONLY unverified claims (no diff/tool output/urls), the renderer
    // falls back to the bare reply BUT must keep the flag attached: dropping
    // it would relay the phantom "Created" claim the section exists to
    // expose. The flag never upgrades a thin completion to "richer" evidence
    // — it only annotates the reply.
    const withFlagOnly = buildCompletionEvidenceString(
      bundle({
        unverifiedClaimedFiles: [
          { path: "src/phantom.ts", reason: "rejected-write" },
        ],
      }),
    );
    expect(withFlagOnly).toContain("did the thing");
    expect(withFlagOnly).toContain("## UNVERIFIED FILE CLAIMS");
    expect(withFlagOnly).toContain("src/phantom.ts");
  });

  it("mentioned URLs and unverified file claims coexist as distinct sections", () => {
    const rendered = buildCompletionEvidenceString(
      bundle({
        verifiedUrls: ["https://real.example/health"],
        mentionedUrls: ["https://claimed.example/deploy"],
        unverifiedClaimedFiles: [
          { path: "src/phantom.ts", reason: "rejected-write" },
        ],
      }),
    );
    expect(rendered).toContain("## VERIFIED URLS");
    expect(rendered).toContain("## CLAIMED URLS");
    expect(rendered).toContain("## UNVERIFIED FILE CLAIMS");
  });
});

describe("appendCompletionEvidenceSection", () => {
  it("appends a verifier section after the assembled evidence", () => {
    const combined = appendCompletionEvidenceSection(
      "base evidence",
      "## EXTRA\ndetail",
    );
    expect(combined).toContain("base evidence");
    expect(combined).toContain("## EXTRA");
    expect(combined.indexOf("base evidence")).toBeLessThan(
      combined.indexOf("## EXTRA"),
    );
  });
});

describe("recorded child tool trace evidence", () => {
  it("renders exact ordered FILE/SHELL operations, command output, and no source payloads", () => {
    const secret = `sk-or-v1-${"a".repeat(48)}`;
    const trace = extractChildToolTrace({
      stages: [
        {
          kind: "tool",
          tool: {
            name: "FILE",
            args: {
              action: "read",
              file_path: "/repo/src/a.ts",
              path: "/repo/src/a.ts",
              content: "private source must not be copied",
            },
            result: {
              success: true,
              text: "private source must not be copied",
            },
          },
        },
        {
          kind: "tool",
          tool: {
            name: "SHELL",
            args: {
              action: "run",
              cwd: "/repo",
              command: `OPENROUTER_API_KEY=${secret} bun test a.test.ts`,
            },
            result: {
              success: true,
              text: `3 pass\n0 fail\nOPENROUTER_API_KEY=${secret}`,
            },
          },
        },
      ],
    });

    expect(trace).toHaveLength(2);
    expect(trace[0]).toMatchObject({
      ordinal: 1,
      tool: "FILE",
      args: {
        action: "read",
        file_path: "/repo/src/a.ts",
        path: "/repo/src/a.ts",
      },
      success: true,
    });
    expect(trace[0]?.output).toBeUndefined();
    expect(JSON.stringify(trace)).not.toContain("private source");
    expect(JSON.stringify(trace)).not.toContain(secret);

    const rendered = buildCompletionEvidenceString(
      bundle({ childToolTrace: trace }),
    );
    expect(rendered).toContain("## CHILD TOOL TRACE");
    expect(rendered).toContain('#1 FILE args={"action":"read"');
    expect(rendered).toContain('"command":"OPENROUTER_API_KEY=');
    expect(rendered).toContain("3 pass");
    expect(rendered).toContain("0 fail");
    expect(rendered).not.toContain(secret);
  });
});
