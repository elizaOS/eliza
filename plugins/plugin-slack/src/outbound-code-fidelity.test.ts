/**
 * What actually leaves the process on the Slack send path when the agent's
 * message contains a fenced code block.
 *
 * This is NOT an end-to-end check against Slack. There is no workspace, token,
 * or Slack renderer in this repo's test setup, so nothing here observes how
 * Slack draws the message or what its code-block copy button yields. What it
 * does observe is the exact `chat.postMessage` payload `SlackService.sendMessage`
 * hands to the Slack Web API client -- the last byte-level state this repository
 * controls -- with the real converter, the real splitter, and the real service
 * method in the path. The Slack client itself is replaced by a recorder so the
 * test runs offline.
 */
import { describe, expect, it } from "vitest";
import { markdownToSlackMrkdwn } from "./formatting";
import { SlackService } from "./service";
import { MAX_SLACK_MESSAGE_LENGTH } from "./types";

type PostedMessage = {
  channel: string;
  text: string;
  mrkdwn?: boolean;
};

function serviceCapturing(posted: PostedMessage[]): SlackService {
  const service = Object.create(SlackService.prototype) as SlackService;
  let seq = 100;
  return Object.assign(service, {
    runtime: {
      agentId: "agent-1",
      logger: {
        warn() {},
        error() {},
        info() {},
        debug() {},
      },
    },
    getOutboundClient: () => ({
      chat: {
        postMessage: async (args: PostedMessage) => {
          posted.push(args);
          seq += 1;
          return { ok: true, ts: `17000000${seq}.000100` };
        },
      },
    }),
  });
}

function hasControlChars(text: string): boolean {
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (code < 9 || (code > 10 && code < 32 && code !== 13)) return true;
  }
  return false;
}

describe("Slack outbound code fidelity", () => {
  it("posts the fenced body unrewritten and entity-escaped, with emphasis around it still converted", async () => {
    const posted: PostedMessage[] = [];
    const service = serviceCapturing(posted);

    await service.sendMessage(
      "C123",
      [
        "Try **this** and _that_:",
        "```sh",
        "# install deps <not-a-tag> && echo [docs](https://ex.com)",
        "grep -o 'a * b'",
        "```",
        "then *ship it*",
      ].join("\n"),
    );

    expect(posted).toHaveLength(1);
    const msg = posted[0];
    expect(msg.channel).toBe("C123");
    // Slack only renders ``` as a code block when mrkdwn is on; without this
    // flag the body would arrive as literal backticks and none of the rest of
    // this test would mean anything about what the operator sees.
    expect(msg.mrkdwn).toBe(true);

    expect(msg.text).toBe(
      [
        "Try *this* and _that_:",
        "```",
        "# install deps &lt;not-a-tag&gt; &amp;&amp; echo [docs](https://ex.com)",
        "grep -o 'a * b'",
        "```",
        "then _ship it_",
      ].join("\n"),
    );

    // No sentinel delimiter reaches the wire.
    expect(hasControlChars(msg.text)).toBe(false);
  });

  it("delivers every character of a message too long for one Slack post", async () => {
    // Formatting repair must not become a reason to drop output: the pieces
    // handed to chat.postMessage have to reassemble into the converted message
    // exactly, with nothing trimmed at the seams.
    const filler = `${"word ".repeat(9_000)}\n`;
    const source = `**lead**\n${filler}\`\`\`sh\n# tail <x> && y\n\`\`\`\n*done*`;
    expect(source.length).toBeGreaterThan(MAX_SLACK_MESSAGE_LENGTH);

    const posted: PostedMessage[] = [];
    const service = serviceCapturing(posted);
    await service.sendMessage("C123", source);

    expect(posted.length).toBeGreaterThan(1);
    expect(posted.map((m) => m.text).join("")).toBe(
      markdownToSlackMrkdwn(source),
    );
    expect(posted.map((m) => m.text).join("")).toContain(
      "```\n# tail &lt;x&gt; &amp;&amp; y\n```",
    );
  });

  it("delivers the tail of a truncated message as code rather than rewriting it", async () => {
    // A streamed or length-capped agent message ends mid-fence. The tail is
    // still code the operator reads and copies, and it is delivered whole.
    const posted: PostedMessage[] = [];
    const service = serviceCapturing(posted);

    await service.sendMessage(
      "C123",
      "here:\n```sh\n# keep *literal* [docs](https://ex.com) && <x>",
    );

    expect(posted).toHaveLength(1);
    expect(posted[0].text).toBe(
      "here:\n```\n# keep *literal* [docs](https://ex.com) &amp;&amp; &lt;x&gt;",
    );
  });
});
