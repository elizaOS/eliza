// spec/cloud/identity/codeChallenges.md, "A challenge sends one code, only to an email address or to a phone in a country the deployment allows"
import { networkInterfaces } from "node:os";
import { Effect } from "effect";
import type { TestCloud } from "./cloud.vibe";
import type { FakeRequest, FakeServer } from "./fakes.ts";

export class InboxEmpty extends Error {}

export const latestCode = (cloud: TestCloud, destination: string) =>
  Effect.flatMap(cloud.call(`/api/test/inbox/${encodeURIComponent(destination)}`), (answer) => {
    const text = answer.status === 200 ? (answer.body as { readonly text?: unknown }).text : undefined;
    const code = typeof text === "string" ? /\b\d{6}\b/.exec(text)?.[0] : undefined;
    return code === undefined ? Effect.fail(new InboxEmpty(`no code for ${destination}: ${answer.status}`)) : Effect.succeed(code);
  });

/** @throws {never} */
export function externalAddress(): string | undefined {
  return Object.values(networkInterfaces()).flat().find((each) => each !== undefined && each.family === "IPv4" && !each.internal)?.address;
}

/** @throws {never} */
export function mountDeliveryProviders(fakes: FakeServer, seen: FakeRequest[], silentFor?: string): void {
  fakes.mount("/mail/", (request) => {
    if (request.path !== "/send") return undefined;
    seen.push(request);
    const to = (JSON.parse(request.body) as { readonly to: ReadonlyArray<string> }).to[0];
    return to === "refused@example.com" ? { status: 422, body: { message: "refused" } } : { status: 200, body: { id: "mail-1" } };
  });
  fakes.mount("/sms/", (request) => {
    if (request.path !== "/messages") return undefined;
    seen.push(request);
    if (new URLSearchParams(request.body).get("To") === silentFor) return { status: 200, chunks: ["{"], hangAfter: 1 };
    return { status: 201, body: { sid: "sms-1" } };
  });
}
