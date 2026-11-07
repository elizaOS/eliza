/**
 * A scheduled-task chat-delivery binding persists the audience
 * `membershipVersion` string minted at bind time. At dispatch,
 * `revalidateScheduledTaskChatDeliveryBinding` recomputes the version from
 * the room's current participants and refuses with
 * `delivery_audience_changed` when the stored string does not match. The
 * recomputation must use code-unit order: ICU collation (`localeCompare`)
 * ranks "aa…" after "b…" under Danish rules, so a binding minted under
 * en_US was refused under da_DK for the identical audience.
 *
 * Bun ignores `LC_ALL`, so the locale cases run in Node child processes
 * (the repo's pinned runtime), which honor it. Each child imports a bundle
 * of this module's TypeScript source (built with `bun build`, the same
 * bundling the module graph needs) and calls the real exported
 * revalidation function with a stub runtime.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const OWNER = "aa000000-0000-4000-8000-000000000001";
const AGENT = "b0000000-0000-4000-8000-000000000002";
const ROOM = "cc000000-0000-4000-8000-000000000003";
const CHANNEL = "chan-1";

let bundleDir: string;
let bundleUrl: string;

beforeAll(() => {
  bundleDir = mkdtempSync(join(tmpdir(), "delivery-binding-"));
  const entry = join(import.meta.dirname, "delivery-binding.ts");
  const outfile = join(bundleDir, "delivery-binding.bundle.mjs");
  execFileSync(
    "bun",
    [
      "build",
      entry,
      "--target=node",
      "--format=esm",
      "--conditions=eliza-source",
      "--outfile",
      outfile,
    ],
    { encoding: "utf8", timeout: 120_000 },
  );
  bundleUrl = pathToFileURL(outfile).href;
}, 180_000);

afterAll(() => {
  if (bundleDir) rmSync(bundleDir, { recursive: true, force: true });
});

type RevalidateResult = {
  collation: string[];
  json: string;
  legacy: string;
};

function revalidateUnderLocale(locale: string): RevalidateResult {
  const script = [
    `import { revalidateScheduledTaskChatDeliveryBinding } from ${JSON.stringify(bundleUrl)};`,
    `const OWNER = ${JSON.stringify(OWNER)};`,
    `const AGENT = ${JSON.stringify(AGENT)};`,
    `const ROOM = ${JSON.stringify(ROOM)};`,
    `const CHANNEL = ${JSON.stringify(CHANNEL)};`,
    "const runtime = {",
    "  agentId: AGENT,",
    '  getRoom: async () => ({ id: ROOM, source: "discord", channelId: CHANNEL, metadata: { accountId: "acct-1" } }),',
    "  getParticipantsForRoom: async () => [AGENT, OWNER],",
    "  reportError: () => {},",
    "};",
    "function record(membershipVersion) {",
    "  return {",
    '    taskId: "task-1",',
    '    channelKey: "discord",',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: placeholder in the child-process script, not in this file
    '    output: { destination: "channel", target: `discord:${CHANNEL}` },',
    "    metadata: { chatDeliveryBinding: {",
    "      version: 1,",
    '      source: "discord",',
    "      roomId: ROOM,",
    "      channelId: CHANNEL,",
    '      accountId: "acct-1",',
    "      audience: {",
    '        kind: "direct",',
    '        provenance: "canonical_room",',
    "        ownerEntityId: OWNER,",
    "        agentEntityId: AGENT,",
    "        participantEntityIds: [OWNER, AGENT],",
    "        membershipVersion,",
    "      },",
    "    } },",
    "  };",
    "}",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: placeholder in the child-process script, not in this file
    'const render = (r) => (r ? (r.ok ? "OK" : `REFUSED:${r.reason}`) : "null");',
    // Exactly what bind minted under en_US before this change.
    "const json = await revalidateScheduledTaskChatDeliveryBinding(runtime, record(JSON.stringify([OWNER, AGENT])));",
    // Legacy NUL-joined form, as minted by the same canonical order.
    'const legacy = await revalidateScheduledTaskChatDeliveryBinding(runtime, record([OWNER, AGENT].join("\\u0000")));',
    "console.log(JSON.stringify({",
    "  collation: [OWNER, AGENT].sort((a, b) => a.localeCompare(b)),",
    "  json: render(json),",
    "  legacy: render(legacy),",
    "}));",
  ].join("\n");
  const result = spawnSync("node", ["--input-type=module", "-e", script], {
    encoding: "utf8",
    env: { ...process.env, LANG: locale, LC_ALL: locale },
    timeout: 30_000,
  });
  if (result.status !== 0) {
    throw new Error(
      `node child (${locale}) failed: ${result.stderr || String(result.error)}`,
    );
  }
  return JSON.parse(result.stdout.trim()) as RevalidateResult;
}

describe("scheduled-task delivery binding revalidation across host locales", () => {
  it("accepts an en_US-minted binding under da_DK for the identical audience", () => {
    const enUs = revalidateUnderLocale("en_US.UTF-8");
    const daDk = revalidateUnderLocale("da_DK.UTF-8");
    // Sanity: the two child locales really do collate this pair in
    // opposite orders, so identical output cannot be a locale no-op.
    expect(enUs.collation).toEqual([OWNER, AGENT]);
    expect(daDk.collation).toEqual([AGENT, OWNER]);
    expect(enUs.json).toBe("OK");
    expect(daDk.json).toBe("OK");
    expect(enUs.legacy).toBe("OK");
    expect(daDk.legacy).toBe("OK");
  }, 60_000);
});
