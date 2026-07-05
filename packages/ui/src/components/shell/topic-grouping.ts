/**
 * Topic grouping for the chat transcript (#8928).
 *
 * Turns a flat message list into topic-clustered segments using the per-message
 * `topics` stamped at Stage-1 (see `MessageMetadata.topics`). A message's
 * dominant topic is its first label; a new segment begins when that dominant
 * topic changes (the "topic break"). Messages with no topic inherit the current
 * segment so the transcript never fragments on every untagged turn.
 *
 * Pure logic — the overlay/ChatView render the segments and a topic chips bar;
 * this module is unit-testable in isolation.
 */

/** Minimal shape the grouping needs from a message. */
export interface TopicTaggedMessage {
  id: string;
  topics?: string[];
}

/** A contiguous run of messages sharing a dominant topic. */
export interface TopicSegment<T extends TopicTaggedMessage> {
  /** Stable key for collapse state — the topic, or the first message id. */
  key: string;
  /** Dominant topic label, or null for an untitled leading run. */
  topic: string | null;
  messages: T[];
}

/** Maximum chips rendered in the topic bar before the rest are summarized. */
export const MAX_TOPIC_CHIPS = 12;

/**
 * Humanize a Stage-1 topic id for display. The tagger emits machine-y labels —
 * snake_case / kebab-case / dotted slugs (`user_greeting`, `deploy-status`,
 * `billing.refund`) — that read as noise in the transcript. Turn a slug into
 * Title Case words; leave already-human labels (those with a space or other
 * non-slug characters) untouched. Returns null only for an empty/whitespace
 * label so callers can fall back to the raw value.
 */
export function humanizeTopicLabel(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Slug detection: only letters/digits and the separators . _ -, no spaces.
  const isSlug = /^[a-z0-9]+([._-][a-z0-9]+)*$/i.test(trimmed);
  if (!isSlug) return trimmed;
  const words = trimmed
    .split(/[._-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
  if (words.length === 0) return null;
  return words.join(" ");
}

function dominantTopic(message: TopicTaggedMessage): string | null {
  const topics = message.topics;
  if (!Array.isArray(topics)) return null;
  for (const topic of topics) {
    if (typeof topic === "string" && topic.trim()) return topic.trim();
  }
  return null;
}

/**
 * Group consecutive messages into topic segments. A new segment starts when a
 * message's dominant topic differs from the current segment's topic; untagged
 * messages extend the current segment.
 */
export function groupMessagesByTopic<T extends TopicTaggedMessage>(
  messages: readonly T[],
): TopicSegment<T>[] {
  const segments: TopicSegment<T>[] = [];
  for (const message of messages) {
    const topic = dominantTopic(message);
    const last = segments[segments.length - 1];
    // Start a new segment on the first message, or when a tagged message
    // introduces a different dominant topic than the current TITLED segment.
    // A leading untitled run (last.topic === null) instead adopts the topic.
    if (
      !last ||
      (topic !== null && last.topic !== null && topic !== last.topic)
    ) {
      segments.push({
        key: topic ?? `untitled-${message.id}`,
        topic,
        messages: [message],
      });
      continue;
    }
    last.messages.push(message);
    // An untitled leading segment adopts the first topic it encounters.
    if (last.topic === null && topic !== null) {
      last.topic = topic;
      last.key = topic;
    }
  }
  return segments;
}

/**
 * Whether the transcript spans genuinely MULTIPLE topics — the only case where
 * the chips bar and topic dividers earn their pixels. A fresh thread with one
 * (or zero) tagged topic must open clean: no chips rail, no divider above the
 * only group. "Multiple" = at least two DISTINCT titled topics present, so a
 * long single-subject thread (or an untitled leading run that later adopts one
 * topic) stays flat. Pass the already-computed segments to avoid re-walking.
 */
export function hasMultipleTopicGroups(
  segments: readonly TopicSegment<TopicTaggedMessage>[],
): boolean {
  const distinct = new Set<string>();
  for (const segment of segments) {
    if (segment.topic) distinct.add(segment.topic);
    if (distinct.size >= 2) return true;
  }
  return false;
}

/**
 * Distinct channel topics across the transcript for the chips bar, ordered
 * most-recent first, capped at {@link MAX_TOPIC_CHIPS}.
 */
export function deriveChannelTopics(
  messages: readonly TopicTaggedMessage[],
): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  // Walk newest → oldest so the most recent topics lead.
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const topics = messages[i]?.topics;
    if (!Array.isArray(topics)) continue;
    for (const raw of topics) {
      if (typeof raw !== "string") continue;
      const topic = raw.trim();
      if (!topic || seen.has(topic)) continue;
      seen.add(topic);
      ordered.push(topic);
      if (ordered.length >= MAX_TOPIC_CHIPS) return ordered;
    }
  }
  return ordered;
}
