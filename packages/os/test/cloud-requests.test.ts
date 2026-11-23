// spec/os/signIn/cloudRequests.md, "Story: Reach my account's cloud services without holding my key"; spec/os/signIn/cloudRequests.md, "Story: Let my agent read my mail and calendar without holding a mail credential"
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import * as client from "../gen/cloud__client.ts";
import * as spec from "../gen/os__signIn__cloudRequests.ts";
import { compileAdapter } from "./drivers/jvm-adapter.ts";

interface Case { readonly fn: string; readonly args: readonly unknown[]; readonly result: unknown }
interface Origins { readonly fn: "originOf"; readonly accepted: Readonly<Record<string, boolean>> }

const javaTool = (name: string) => process.env.JAVA_HOME ? `${process.env.JAVA_HOME}/bin/${name}` : name;

function javaLines(): { readonly cases: Case[]; readonly origins: Origins } {
  const main = "ai.eliza.plugins.signin.CloudRequestLawCheck";
  const out = execFileSync(javaTool("java"), ["-cp", compileAdapter(main), main], { encoding: "utf8", maxBuffer: 1 << 29 });
  const lines = out.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Case | Origins);
  const origins = lines.find((line): line is Origins => line.fn === "originOf");
  if (origins === undefined) throw new Error("the law check printed no originOf line");
  return { cases: lines.filter((line): line is Case => line.fn !== "originOf"), origins };
}

const functions = { ...client, ...spec } as unknown as Record<string, unknown>;

function expected(c: Case): unknown {
  const value = functions[c.fn];
  return typeof value === "function" ? (value as (...args: readonly unknown[]) => unknown)(...c.args) : value;
}

describe("Reach my account's cloud services without holding my key", () => {
  const { cases, origins } = javaLines();

  it("admits, attaches, reports and hands off as the generated spec does over every value the spec names", () => {
    const names = new Set(cases.map((c) => c.fn));
    expect(cases.length).toBeGreaterThan(5000);
    expect([...names].filter((name) => functions[name] === undefined)).toEqual([]);
    const differing = cases.filter((c) => JSON.stringify(expected(c)) !== JSON.stringify(c.result));
    expect(differing.slice(0, 5)).toEqual([]);
    for (const law of [...names].filter((name) => name.startsWith("law"))) {
      expect(cases.filter((c) => c.fn === law && c.result !== true)).toEqual([]);
    }
  });

  it("refuses a table with a sign-in, streamed or unlisted route whole and admits only listed calls from the wire", () => {
    const accepted = cases.filter((c) => c.fn === "cloudTableAccepted").map((c) => c.result);
    expect(accepted.slice(-5)).toEqual([true, false, false, false, false]);
    const sent = cases.filter((c) => c.fn === "planRequest" && (c.result as { tag: string }).tag === "Send");
    expect(sent.length).toBeGreaterThan(0);
    for (const c of sent) expect(c.args[4]).not.toContain("Authorization");
  });

  it("sends only to an https origin, or http on loopback, with no path, user, query or fragment", () => {
    expect(origins.accepted).toEqual({
      "https://api.cloud.test": true,
      "https://api.cloud.test/": false,
      "https://api.cloud.test/v1": false,
      "http://127.0.0.1:8080": true,
      "http://api.cloud.test": false,
      "https://user@api.cloud.test": false,
      "https://api.cloud.test?x=1": false,
      "ftp://api.cloud.test": false,
      "not a url": false,
    });
  });
});

describe("Let my agent read my mail and calendar without holding a mail credential", () => {
  const main = "ai.eliza.plugins.signin.GoogleBrokerJourney";
  let walked: Readonly<Record<string, unknown>> | undefined;
  const journey = () => walked ??= JSON.parse(execFileSync(javaTool("java"), ["-cp", compileAdapter(main), main], { encoding: "utf8", timeout: 120_000 })) as Record<string, unknown>;
  const scoped = (connectionId: string) => `alpha-google:${createHash("sha256").update(`alpha-google\n${connectionId}`).digest("hex")}`;
  const calendarGrant = "11111111-2222-4333-8444-555555555555";

  it("refuses a request that is not the agent's private, authorized and bounded ask before any cloud call, and hands the agent only its address and bearer", () => {
    const seen = journey();
    expect([seen.sameEndpointOnReopen, seen.endpointHidesBearer, seen.environmentUrl]).toEqual([true, true, true]);
    expect(seen.environment).toEqual(["ELIZA_API_TOKEN", "ELIZA_MANAGED_CALENDAR_READ_BROKER", "ELIZA_MANAGED_GMAIL_READ_BROKER"]);
    expect(seen.refusals).toEqual({ wrongBearer: 401, noBearer: 401, withOrigin: 403, wrongHost: 403, wrongPath: 403, get: 403, tooLarge: 413 });
    expect(seen.cloudCallsAfterRefusals).toBe(0);
    expect([seen.otherBearerRefused, seen.closedRefusesConnections]).toEqual([401, true]);
  });

  it("reads nothing for a send, a mailbox change, a message read, a calendar write or an unbounded search", () => {
    const seen = journey();
    expect(seen.unlisted).toEqual({
      searchOf30: '409 {"reason":"operation-refused"}', emptyQuery: 409, messageRead: 409, send: 409, mailbox: 409, calendarWrite: 409,
      extraField: 409, twoOperations: 409, unscopedFeed: 409, notJson: 409,
    });
    expect(seen.cloudCallsAfterUnlisted).toBe(0);
  });

  it("reads Gmail status and search and the calendar list and feed through listed GET routes with the device's credential, which no reply shows", () => {
    const seen = journey();
    expect([seen.statusReply, seen.statusConnectionId, seen.searchReply, seen.searchHistory]).toEqual([200, calendarGrant, 200, "41"]);
    expect(seen.oversizeSearch).toBe('502 {"reason":"reply-too-large"}');
    expect([seen.everyCallCarriedTheDeviceCredential, seen.noReplyShowedTheCredential]).toEqual([true, true]);
    expect((seen.cloudTargets as string[]).every((target) => target.startsWith("GET /api/v1/eliza/google/") && target.includes("side=owner"))).toBe(true);
    expect(seen.cloudTargets).toContain("GET /api/v1/eliza/google/gmail/search?side=owner&grantId=66666666-7777-4888-9999-000000000000&query=from%3Abo%20in%3Ainbox&maxResults=25");
    expect([seen.signedOutStatus, seen.signedOutCloudCalls]).toEqual(['503 {"reason":"cloud-unreachable"}', 0]);
  });

  it("lists only readable calendars of calendar connections under scoped grants, and feeds exactly the selected calendar and window", () => {
    const seen = journey();
    const grant = scoped(calendarGrant);
    expect([seen.sourcesReply, seen.feedReply, seen.staleGrantFeed]).toEqual([200, 200, 404]);
    expect(seen.sources).toEqual({ calendars: [{
      provider: "google", side: "owner", grantId: grant, connectorAccountId: grant, calendarId: "primary@example.com", summary: "Ana", accessRole: "owner",
      accountEmail: "ana@example.com", managedGoogleConnectionId: calendarGrant,
    }] });
    const feed = (seen.feed as { feed: Record<string, unknown> }).feed;
    expect([feed.calendarId, feed.state, feed.source, feed.timeMin, feed.timeMax]).toEqual(["primary@example.com", "complete", "synced", "2026-11-21T00:00:00.000Z", "2026-11-22T00:00:00.000Z"]);
    expect(feed.sources).toEqual([{ key: { provider: "google", side: "owner", grantId: grant, connectorAccountId: grant, calendarId: "primary@example.com" }, status: "fresh", syncedAt: "2026-11-20T10:00:00.000Z" }]);
    expect((feed.events as Record<string, unknown>[]).map((event) => [event.id, event.grantId, event.connectorAccountId, event.recurringEventId])).toEqual([[`${grant}:ev1`, grant, grant, "series-1"]]);
  });
});
