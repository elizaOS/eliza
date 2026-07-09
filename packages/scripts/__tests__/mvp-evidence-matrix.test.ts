/**
 * Offline coverage for the MVP evidence matrix. The live command reads GitHub,
 * but the closeout contract is deterministic over issue labels, titles, and
 * Project rows, so agents can refine the checklist without network access.
 */

import { describe, expect, test } from "bun:test";

const matrix = await import(
  new URL("../audit-mvp-evidence-matrix.mjs", import.meta.url).href
);

function issue(number: number, title: string, labels: string[], body = "") {
  return {
    number,
    title,
    body,
    url: `https://github.com/elizaOS/eliza/issues/${number}`,
    labels: labels.map((name) => ({ name })),
  };
}

function projectItem(number: number, status = "Needs human review") {
  return {
    content: {
      type: "Issue",
      number,
      repository: "elizaOS/eliza",
      title: `Issue ${number}`,
    },
    status,
  };
}

function evidenceIds(row: { evidence: Array<{ id: string }> }) {
  return row.evidence.map((evidence) => evidence.id);
}

describe("MVP evidence matrix", () => {
  test("adds visual, walkthrough, and device proof for device onboarding UI rows", () => {
    const report = matrix.buildEvidenceMatrix(
      [
        issue(14358, "[onboarding] Device e2e for iOS sim + Android emu", [
          "mvp",
          "ui",
          "needs-human",
        ]),
      ],
      { items: [projectItem(14358)] },
    );

    expect(report.counts).toEqual({
      openMvpIssues: 1,
      humanGated: 1,
      agentActionable: 0,
    });
    expect(report.rows[0].projectStatus).toBe("Needs human review");
    expect(evidenceIds(report.rows[0])).toEqual(
      expect.arrayContaining([
        "issue-closeout-summary",
        "logs",
        "domain-artifacts",
        "visual-screenshots-ocr-color",
        "walkthrough-video",
        "device-artifact-bundle",
      ]),
    );
  });

  test("adds live model, connector, and security proof for corpus and permissioning rows", () => {
    const report = matrix.buildEvidenceMatrix(
      [
        issue(14747, "[corpus] Personal-corpus scenario program", [
          "mvp",
          "testing",
          "connector",
          "memory",
          "security",
          "needs-shaw",
        ]),
      ],
      { items: [projectItem(14747)] },
    );

    expect(evidenceIds(report.rows[0])).toEqual(
      expect.arrayContaining([
        "live-llm-trajectory",
        "connector-dispatch-proof",
        "security-redaction-proof",
      ]),
    );
  });

  test("adds audio evidence for voice rows", () => {
    const report = matrix.buildEvidenceMatrix(
      [
        issue(14374, "[voice] Railway Kokoro/Whisper services", [
          "mvp",
          "voice",
          "needs-human",
        ]),
      ],
      { items: [projectItem(14374)] },
    );

    expect(evidenceIds(report.rows[0])).toContain("voice-audio-latency");
    expect(evidenceIds(report.rows[0])).toContain("walkthrough-video");
  });

  test("keeps open non-blocked MVP issues visible as agent-actionable", () => {
    const report = matrix.buildEvidenceMatrix(
      [issue(15000, "[mvp] Missing blocker", ["mvp", "testing"])],
      { items: [projectItem(15000, "In progress")] },
    );

    expect(report.counts.agentActionable).toBe(1);
    expect(
      report.agentActionable.map((row: { number: number }) => row.number),
    ).toEqual([15000]);
  });

  test("ignores project rows from another repository when assigning status", () => {
    const report = matrix.buildEvidenceMatrix(
      [issue(14783, "[scenarios] Pack G1", ["mvp", "needs-shaw"])],
      {
        items: [
          {
            content: {
              type: "Issue",
              number: 14783,
              repository: "elizaOS/other",
            },
            status: "Done",
          },
        ],
      },
    );

    expect(report.rows[0].projectStatus).toBeNull();
  });
});
