// Unit coverage for the pure topic-clustering helpers (#8928): groupMessagesByTopic
// segments a transcript by dominant topic (untagged messages extend the current
// run, no fragmentation) and deriveChannelTopics ranks the channel's chips.
// Pure functions, no harness.
import { describe, expect, it } from "vitest";
import {
  deriveChannelTopics,
  groupMessagesByTopic,
  hasMultipleTopicGroups,
  humanizeTopicLabel,
  MAX_TOPIC_CHIPS,
  type TopicTaggedMessage,
} from "./topic-grouping";

const m = (id: string, topics?: string[]): TopicTaggedMessage => ({
  id,
  topics,
});

describe("groupMessagesByTopic", () => {
  it("returns a single null segment when no message has topics", () => {
    const segments = groupMessagesByTopic([m("1"), m("2"), m("3")]);
    expect(segments).toHaveLength(1);
    expect(segments[0].topic).toBeNull();
    expect(segments[0].messages).toHaveLength(3);
  });

  it("starts a new segment when the dominant topic changes", () => {
    const segments = groupMessagesByTopic([
      m("1", ["billing"]),
      m("2", ["billing"]),
      m("3", ["deployment"]),
      m("4", ["deployment"]),
    ]);
    expect(segments.map((s) => s.topic)).toEqual(["billing", "deployment"]);
    expect(segments[0].messages.map((x) => x.id)).toEqual(["1", "2"]);
    expect(segments[1].messages.map((x) => x.id)).toEqual(["3", "4"]);
  });

  it("untagged messages extend the current segment (no fragmentation)", () => {
    const segments = groupMessagesByTopic([
      m("1", ["billing"]),
      m("2"),
      m("3"),
      m("4", ["deployment"]),
    ]);
    expect(segments).toHaveLength(2);
    expect(segments[0].messages.map((x) => x.id)).toEqual(["1", "2", "3"]);
    expect(segments[1].messages.map((x) => x.id)).toEqual(["4"]);
  });

  it("a leading untitled run adopts the first topic it sees", () => {
    const segments = groupMessagesByTopic([m("1"), m("2", ["billing"])]);
    expect(segments).toHaveLength(1);
    expect(segments[0].topic).toBe("billing");
    expect(segments[0].key).toBe("billing");
  });

  it("uses the first label as the dominant topic", () => {
    const segments = groupMessagesByTopic([
      m("1", ["billing", "refunds"]),
      m("2", ["refunds", "billing"]),
    ]);
    // dominant = first label, so these differ → two segments
    expect(segments.map((s) => s.topic)).toEqual(["billing", "refunds"]);
  });
});

describe("deriveChannelTopics", () => {
  it("returns distinct topics most-recent-first", () => {
    const topics = deriveChannelTopics([
      m("1", ["billing"]),
      m("2", ["deployment", "billing"]),
      m("3", ["latency"]),
    ]);
    expect(topics).toEqual(["latency", "deployment", "billing"]);
  });

  it("is empty when no message has topics", () => {
    expect(deriveChannelTopics([m("1"), m("2")])).toEqual([]);
  });

  it("caps the number of chips", () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      m(`${i}`, [`topic-${i}`]),
    );
    expect(deriveChannelTopics(many)).toHaveLength(MAX_TOPIC_CHIPS);
  });
});

describe("hasMultipleTopicGroups", () => {
  it("is false for an all-untitled transcript (no topics)", () => {
    const segments = groupMessagesByTopic([m("1"), m("2")]);
    expect(hasMultipleTopicGroups(segments)).toBe(false);
  });

  it("is false for a single-topic thread (the divider would be noise)", () => {
    // A fresh thread whose only topic is `greeting` — the exact leak Shadow
    // saw: one titled group must NOT trigger the chips bar or a divider.
    const segments = groupMessagesByTopic([
      m("1", ["greeting"]),
      m("2", ["greeting"]),
    ]);
    expect(hasMultipleTopicGroups(segments)).toBe(false);
  });

  it("is false when a leading untitled run adopts one topic", () => {
    const segments = groupMessagesByTopic([m("1"), m("2", ["billing"])]);
    expect(segments).toHaveLength(1);
    expect(hasMultipleTopicGroups(segments)).toBe(false);
  });

  it("is true once two DISTINCT topics are present", () => {
    const segments = groupMessagesByTopic([
      m("1", ["billing"]),
      m("2", ["deployment"]),
    ]);
    expect(hasMultipleTopicGroups(segments)).toBe(true);
  });

  it("counts distinct topics, not segment runs (A → B → A is multi)", () => {
    const segments = groupMessagesByTopic([
      m("1", ["billing"]),
      m("2", ["deployment"]),
      m("3", ["billing"]),
    ]);
    expect(segments).toHaveLength(3);
    expect(hasMultipleTopicGroups(segments)).toBe(true);
  });
});

describe("humanizeTopicLabel", () => {
  it("title-cases snake_case slugs", () => {
    expect(humanizeTopicLabel("user_greeting")).toBe("User Greeting");
  });

  it("title-cases kebab and dotted slugs", () => {
    expect(humanizeTopicLabel("deploy-status")).toBe("Deploy Status");
    expect(humanizeTopicLabel("billing.refund")).toBe("Billing Refund");
  });

  it("title-cases a bare single-word slug", () => {
    expect(humanizeTopicLabel("greeting")).toBe("Greeting");
  });

  it("leaves an already-human multi-word label untouched", () => {
    expect(humanizeTopicLabel("Q3 planning notes")).toBe("Q3 planning notes");
  });

  it("returns null for an empty/whitespace label", () => {
    expect(humanizeTopicLabel("")).toBeNull();
    expect(humanizeTopicLabel("   ")).toBeNull();
  });
});
