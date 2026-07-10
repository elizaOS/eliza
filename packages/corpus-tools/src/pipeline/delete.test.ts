/**
 * Adversarial coverage for deterministic deletion planning and owner review.
 * The suite uses only synthetic messages and checks that private source content
 * cannot cross into tombstone, approval, or public-report artifacts.
 */

import { describe, expect, it } from "vitest";
import type { CorpusMessage } from "../schema.ts";
import {
  applyDeletionReview,
  buildDeletionReviewQueue,
  canonicalDeletionArtifactSha256,
  type DeletionReviewDecisions,
  type DeletionReviewQueue,
  type DeletionRule,
  type DeletionRules,
  parseDeletionReviewDecisions,
  parseDeletionReviewQueue,
  parseDeletionRules,
} from "./delete.ts";

const RULESET = "delete-test-v1";
const ATTACHMENT_POLICY: DeletionRules["attachmentPolicy"] = {
  embeddedBytes: "drop" as const,
  retainMetadata: ["filename", "mimeType", "sha256"],
};

function message(
  id: string,
  overrides: Partial<CorpusMessage> = {},
): CorpusMessage {
  return {
    id,
    platform: "gmail",
    accountId: "work",
    threadId: `thread-${id}`,
    ts: Date.parse("2026-06-01T12:00:00.000Z"),
    direction: "in",
    senderId: `sender-${id}`,
    senderDisplay: `Sender ${id}`,
    recipients: [{ id: "owner", address: "owner@example.test" }],
    text: `Synthetic content for ${id}.`,
    labels: [],
    attachments: [],
    scrubState: "swapped",
    ...overrides,
  };
}

function rules(
  entries: DeletionRules["rules"],
  overrides: Partial<DeletionRules> = {},
): DeletionRules {
  return {
    schemaVersion: 1,
    rulesetVersion: RULESET,
    attachmentPolicy: ATTACHMENT_POLICY,
    rules: entries,
    ...overrides,
  };
}

function approve(
  queue: DeletionReviewQueue,
  decisionFor: (groupId: string) => "delete" | "keep" = () => "delete",
): DeletionReviewDecisions {
  return {
    schemaVersion: 1,
    rulesetVersion: queue.rulesetVersion,
    corpusDigest: queue.corpusDigest,
    rulesSha256: queue.rulesSha256,
    reviewedQueueSha256: canonicalDeletionArtifactSha256(queue),
    approved: true,
    reviewedBy: "synthetic-owner",
    reviewedAt: "2026-07-10T05:00:00.000Z",
    decisions: queue.groups.map((group) => ({
      groupId: group.groupId,
      decision: decisionFor(group.groupId),
    })),
  };
}

describe("deletion rule validation", () => {
  it("accepts strict JSON/YAML-decoded data and rejects unknown keys", () => {
    const valid = rules([
      {
        id: "medical-contact",
        enabled: true,
        scope: "thread",
        match: {
          type: "contact",
          platform: "gmail",
          accountId: "work",
          contactId: "doctor@example.test",
        },
      },
    ]);
    expect(parseDeletionRules(valid)).toEqual(valid);
    expect(() =>
      parseDeletionRules({ ...valid, yamlMerge: "forbidden" }),
    ).toThrow();
    expect(() =>
      parseDeletionRules({
        ...valid,
        rules: [{ ...valid.rules[0], unexpected: true }],
      }),
    ).toThrow();
  });

  it("rejects duplicate rule ids, duplicate keyword fields, and regex-like ids", () => {
    const duplicate: DeletionRule = {
      id: "private-topic",
      enabled: true,
      scope: "message" as const,
      match: {
        type: "keyword" as const,
        value: "medical",
        mode: "token" as const,
        fields: ["text"],
      },
    };
    expect(() => parseDeletionRules(rules([duplicate, duplicate]))).toThrow(
      "duplicate deletion rule id",
    );
    expect(() =>
      parseDeletionRules(
        rules([
          {
            ...duplicate,
            id: "duplicate-fields",
            match: { ...duplicate.match, fields: ["text", "text"] },
          },
        ]),
      ),
    ).toThrow("keyword fields must be unique");
    expect(() =>
      parseDeletionRules(rules([{ ...duplicate, id: "(medical)+" }])),
    ).toThrow();
  });
});

describe("deletion review planning", () => {
  it("matches contact, thread, detector, keyword, and label rules with compound-thread isolation", () => {
    const messages = [
      message("contact-1", {
        threadId: "shared-thread",
        senderId: "doctor@example.test",
        text: "Follow-up from the clinic.",
      }),
      message("contact-2", {
        threadId: "shared-thread",
        text: "Second message in the same relationship.",
      }),
      message("other-account", {
        accountId: "personal",
        threadId: "shared-thread",
      }),
      message("thread-rule", { threadId: "legal-thread" }),
      message("detector", { text: "Already placeholdered account record." }),
      message("keyword", { text: "MEDICAL follow up" }),
      message("label", { labels: ["Receipts"] }),
    ];
    const queue = buildDeletionReviewQueue({
      messages,
      candidates: [{ msgId: "detector", kind: "credit-card" }],
      rules: rules([
        {
          id: "medical-contact",
          enabled: true,
          scope: "thread",
          match: {
            type: "contact",
            platform: "gmail",
            accountId: "work",
            contactId: "doctor@example.test",
          },
        },
        {
          id: "legal-thread",
          enabled: true,
          scope: "thread",
          match: {
            type: "thread",
            platform: "gmail",
            accountId: "work",
            threadId: "legal-thread",
          },
        },
        {
          id: "financial-detector",
          enabled: true,
          scope: "message",
          match: { type: "detector", kind: "credit-card" },
        },
        {
          id: "medical-keyword",
          enabled: true,
          scope: "message",
          match: {
            type: "keyword",
            value: "medical",
            mode: "token",
            fields: ["text"],
          },
        },
        {
          id: "receipt-label",
          enabled: true,
          scope: "message",
          match: { type: "label", value: "receipts" },
        },
      ]),
    });

    expect(queue.groups).toHaveLength(5);
    expect(
      queue.groups.find((group) => group.messageIds.includes("contact-1"))
        ?.messageIds,
    ).toEqual(["contact-1", "contact-2"]);
    expect(
      queue.groups.some((group) => group.messageIds.includes("other-account")),
    ).toBe(false);
    expect(queue.groups.flatMap((group) => group.matchClasses).sort()).toEqual([
      "contact",
      "detector",
      "keyword",
      "label",
      "thread",
    ]);
  });

  it("folds message matches into a selected thread so review cannot conflict", () => {
    const messages = [
      message("one", { threadId: "private", text: "medical note" }),
      message("two", { threadId: "private" }),
    ];
    const queue = buildDeletionReviewQueue({
      messages,
      candidates: [],
      rules: rules([
        {
          id: "private-thread",
          enabled: true,
          scope: "thread",
          match: {
            type: "thread",
            platform: "gmail",
            accountId: "work",
            threadId: "private",
          },
        },
        {
          id: "medical-word",
          enabled: true,
          scope: "message",
          match: {
            type: "keyword",
            value: "medical",
            mode: "token",
            fields: ["text"],
          },
        },
      ]),
    });
    expect(queue.groups).toHaveLength(1);
    expect(queue.groups[0].messageIds).toEqual(["one", "two"]);
    expect(queue.groups[0].matchClasses).toEqual(["keyword", "thread"]);
  });

  it("uses Unicode-stable literal matching and token boundaries", () => {
    const messages = [
      message("exact", { text: "Discuss Médical options." }),
      message("embedded", { text: "The biomedical project is public." }),
      message("literal", { text: "Keep (medical)+ as literal text." }),
    ];
    const queue = buildDeletionReviewQueue({
      messages,
      candidates: [],
      rules: rules([
        {
          id: "unicode-token",
          enabled: true,
          scope: "message",
          match: {
            type: "keyword",
            value: "médical",
            mode: "token",
            fields: ["text"],
          },
        },
        {
          id: "literal-substring",
          enabled: true,
          scope: "message",
          match: {
            type: "keyword",
            value: "(medical)+",
            mode: "substring",
            fields: ["text"],
          },
        },
      ]),
    });
    expect(queue.groups.map((group) => group.messageIds[0]).sort()).toEqual([
      "exact",
      "literal",
    ]);
  });

  it("fails closed on stale candidates and duplicate message ids", () => {
    const current = message("current");
    expect(() =>
      buildDeletionReviewQueue({
        messages: [current],
        candidates: [{ msgId: "missing", kind: "ssn" }],
        rules: rules([]),
      }),
    ).toThrow("references missing message");
    expect(() =>
      buildDeletionReviewQueue({
        messages: [current, { ...current }],
        candidates: [],
        rules: rules([]),
      }),
    ).toThrow("duplicate corpus message id");
  });

  it("refuses raw or mined input before producing review artifacts", () => {
    for (const scrubState of ["raw", "mined"] as const) {
      expect(() =>
        buildDeletionReviewQueue({
          messages: [message(scrubState, { scrubState })],
          candidates: [],
          rules: rules([]),
        }),
      ).toThrow(`message ${scrubState} is ${scrubState}`);
    }
  });

  it("is byte-stable across message, candidate, and rule ordering", () => {
    const messages = [
      message("a", { text: "medical" }),
      message("b", { text: "financial" }),
    ];
    const ruleList: DeletionRules["rules"] = [
      {
        id: "medical",
        enabled: true,
        scope: "message",
        match: {
          type: "keyword",
          value: "medical",
          mode: "token",
          fields: ["text"],
        },
      },
      {
        id: "financial",
        enabled: true,
        scope: "message",
        match: { type: "detector", kind: "iban" },
      },
    ];
    const first = buildDeletionReviewQueue({
      messages,
      candidates: [{ msgId: "b", kind: "iban" }],
      rules: rules(ruleList),
    });
    const second = buildDeletionReviewQueue({
      messages: [...messages].reverse(),
      candidates: [{ msgId: "b", kind: "iban" }].reverse(),
      rules: rules([...ruleList].reverse()),
    });
    expect(second).toEqual(first);
    expect(canonicalDeletionArtifactSha256(second)).toBe(
      canonicalDeletionArtifactSha256(first),
    );
  });
});

describe("reviewed deletion application", () => {
  it("requires one exact decision per group and rejects stale bindings", () => {
    const messages = [message("delete-me", { text: "medical" })];
    const queue = buildDeletionReviewQueue({
      messages,
      candidates: [],
      rules: rules([
        {
          id: "medical",
          enabled: true,
          scope: "message",
          match: {
            type: "keyword",
            value: "medical",
            mode: "token",
            fields: ["text"],
          },
        },
      ]),
    });
    const complete = approve(queue);
    expect(() =>
      applyDeletionReview({
        messages,
        queue,
        decisions: { ...complete, decisions: [] },
      }),
    ).toThrow("missing deletion decision");
    expect(() =>
      applyDeletionReview({
        messages,
        queue,
        decisions: { ...complete, corpusDigest: "0".repeat(64) },
      }),
    ).toThrow("corpus binding mismatch");
    expect(() =>
      parseDeletionReviewDecisions({
        ...complete,
        decisions: [complete.decisions[0], complete.decisions[0]],
      }),
    ).toThrow("duplicate deletion decision");
    expect(() =>
      parseDeletionReviewQueue({
        ...queue,
        groups: [queue.groups[0], queue.groups[0]],
      }),
    ).toThrow("duplicate deletion review group");
  });

  it("strips attachment payload fields, keeps metadata, and never mutates inputs", () => {
    const privateText = "PRIVATE-MEDICAL-CONTENT";
    const deleted = message("deleted", {
      text: privateText,
      attachments: [
        {
          filename: "private.txt",
          mimeType: "text/plain",
          sha256: "c".repeat(64),
          dataBase64: "cHJpdmF0ZQ==",
        },
      ],
    });
    const survivor = message("survivor", {
      attachments: [
        {
          filename: "safe.pdf",
          mimeType: "application/pdf",
          sha256: "a".repeat(64),
          bytes: 42,
          dataBase64: "cHJpdmF0ZS1ieXRlcw==",
        },
      ],
    });
    const messages = [deleted, survivor];
    const snapshot = JSON.stringify(messages);
    const queue = buildDeletionReviewQueue({
      messages,
      candidates: [],
      rules: rules([
        {
          id: "private-medical",
          enabled: true,
          scope: "message",
          match: {
            type: "keyword",
            value: privateText,
            mode: "token",
            fields: ["text"],
          },
        },
      ]),
    });
    const applied = applyDeletionReview({
      messages,
      queue,
      decisions: approve(queue),
    });

    expect(JSON.stringify(messages)).toBe(snapshot);
    expect(applied.survivors).toEqual([
      {
        ...survivor,
        attachments: [
          {
            filename: "safe.pdf",
            mimeType: "application/pdf",
            sha256: "a".repeat(64),
          },
        ],
      },
    ]);
    expect(applied.approval.attachmentBytesDropped).toBe(2);
    expect(applied.tombstones).toHaveLength(1);
    const publicArtifacts = JSON.stringify({
      tombstones: applied.tombstones,
      approval: applied.approval,
      report: applied.report,
    });
    expect(publicArtifacts).not.toContain(privateText);
    expect(publicArtifacts).not.toContain("private-medical");
    expect(publicArtifacts).not.toContain("thread-deleted");
    expect(applied.report.reportDigest).toBe(
      canonicalDeletionArtifactSha256({
        ...applied.report,
        reportDigest: undefined,
      }),
    );
  });

  it("supports explicit keeps and an approved zero-match review", () => {
    const kept = message("kept", {
      text: "medical",
      attachments: [
        {
          filename: "note.txt",
          mimeType: "text/plain",
          sha256: "b".repeat(64),
          dataBase64: "bm90ZQ==",
        },
      ],
    });
    const queue = buildDeletionReviewQueue({
      messages: [kept],
      candidates: [],
      rules: rules([
        {
          id: "medical",
          enabled: true,
          scope: "message",
          match: {
            type: "keyword",
            value: "medical",
            mode: "token",
            fields: ["text"],
          },
        },
      ]),
    });
    const explicitlyKept = applyDeletionReview({
      messages: [kept],
      queue,
      decisions: approve(queue, () => "keep"),
    });
    expect(explicitlyKept.tombstones).toEqual([]);
    expect(explicitlyKept.survivors[0].attachments[0]).not.toHaveProperty(
      "dataBase64",
    );

    const emptyQueue = buildDeletionReviewQueue({
      messages: [message("ordinary")],
      candidates: [],
      rules: rules([]),
    });
    const emptyResult = applyDeletionReview({
      messages: [message("ordinary")],
      queue: emptyQueue,
      decisions: approve(emptyQueue),
    });
    expect(emptyResult.approval).toMatchObject({
      approved: true,
      tombstoneCount: 0,
      survivorCount: 1,
    });
  });

  it("changes the stage version when reviewed decisions change", () => {
    const messages = [
      message("one", { text: "medical" }),
      message("two", { text: "medical" }),
    ];
    const queue = buildDeletionReviewQueue({
      messages,
      candidates: [],
      rules: rules([
        {
          id: "medical",
          enabled: true,
          scope: "message",
          match: {
            type: "keyword",
            value: "medical",
            mode: "token",
            fields: ["text"],
          },
        },
      ]),
    });
    const allDeleted = applyDeletionReview({
      messages,
      queue,
      decisions: approve(queue),
    });
    const firstKept = applyDeletionReview({
      messages,
      queue,
      decisions: approve(queue, (groupId) =>
        groupId === queue.groups[0].groupId ? "keep" : "delete",
      ),
    });
    expect(firstKept.approval.deleteStageVersion).not.toBe(
      allDeleted.approval.deleteStageVersion,
    );
    expect(firstKept.approval.tombstoneCount).toBe(1);
  });

  it("binds the exact tombstoned id set even when counts are equal", () => {
    const messages = [
      message("one", { text: "medical" }),
      message("two", { text: "medical" }),
    ];
    const queue = buildDeletionReviewQueue({
      messages,
      candidates: [],
      rules: rules([
        {
          id: "medical",
          enabled: true,
          scope: "message",
          match: {
            type: "keyword",
            value: "medical",
            mode: "token",
            fields: ["text"],
          },
        },
      ]),
    });
    const deleteOne = (wanted: string) =>
      applyDeletionReview({
        messages,
        queue,
        decisions: approve(queue, (groupId) => {
          const group = queue.groups.find((item) => item.groupId === groupId);
          return group?.messageIds.includes(wanted) ? "delete" : "keep";
        }),
      });
    const first = deleteOne("one");
    const second = deleteOne("two");
    expect(first.approval.tombstoneCount).toBe(1);
    expect(second.approval.tombstoneCount).toBe(1);
    expect(first.approval.tombstoneIdsSha256).not.toBe(
      second.approval.tombstoneIdsSha256,
    );
    expect(first.approval.tombstoneIdsSha256).toBe(
      canonicalDeletionArtifactSha256(["one"]),
    );
  });
});
