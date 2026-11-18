// spec/cloud/identity/codeChallenges.md, "A challenge sends one code, only to an email address or to a phone in a country the deployment allows"
import { networkInterfaces } from "node:os";
import { Effect } from "effect";
import type { TestCloud } from "./cloud.vibe";

export class InboxEmpty extends Error {}

export const latestCode = (cloud: TestCloud, destination: string) =>
  Effect.flatMap(cloud.call(`/api/test/inbox/${encodeURIComponent(destination)}`), (answer) => {
    const text = answer.status === 200 ? (answer.body as { readonly text?: unknown }).text : undefined;
    const code = typeof text === "string" ? /\b\d{6}\b/.exec(text)?.[0] : undefined;
    return code === undefined ? Effect.fail(new InboxEmpty(`no code for ${destination}: ${answer.status}`)) : Effect.succeed(code);
  });

export function externalAddress(): string | undefined {
  return Object.values(networkInterfaces()).flat().find((each) => each !== undefined && each.family === "IPv4" && !each.internal)?.address;
}
