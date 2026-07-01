/**
 * Bug B regression: incidental routed-domain URLs in a sub-agent's free-text
 * narration must NOT trigger URL verification (and therefore must NOT cause a
 * dead-URL retry that surfaces "something glitched, give me another go") when
 * the TASK never requested a reachable artifact/URL.
 *
 * A "build a static site in its own folder" task (no deploy/URL requested)
 * routinely has codex's exploratory narration surface incidental URLs — e.g.
 * an `/apps/<slug>/`-shaped URL it grepped out of skill code, a CDN link, or a
 * telemetry endpoint. Those are NOT deliverables. The verifier gate must key on
 * the task's own intent (it asked for a reachable artifact) or an explicit
 * deployment route the task set up — never on the mere shape of a URL that
 * appears in narration.
 *
 * The legitimate case ("deploy X and give me the live URL" → dead URL) must
 * still verify + flag.
 */

import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  annotateUnverifiedUrls,
  type RouteUrlVerification,
} from "../../src/services/sub-agent-router.js";

describe("verify: incidental narration URLs (Bug B)", () => {
  const origSettle = process.env.ELIZA_URL_VERIFY_SETTLE_MS;

  beforeEach(() => {
    // Single fast probe, no 2.5s settle-retry.
    process.env.ELIZA_URL_VERIFY_SETTLE_MS = "0";
  });
  afterEach(() => {
    if (origSettle === undefined) delete process.env.ELIZA_URL_VERIFY_SETTLE_MS;
    else process.env.ELIZA_URL_VERIFY_SETTLE_MS = origSettle;
  });

  it("does NOT verify an incidental routed-domain URL when the task did not request a reachable artifact", async () => {
    // Task: "make a folder and put three text files in it" — no app/site/build/
    // deploy/url language, so `taskRequestsReachableArtifact` is false. The
    // narration incidentally mentions an /apps/<slug>/-shaped URL the agent
    // grepped from skill source. There is NO route mapping (the task set up no
    // deployment), so verification must be skipped entirely — no probe, no
    // dead URL, no retry.
    const referenceText =
      "make a folder named notes and put three text files in it";
    // A dead URL: if the gate WRONGLY verifies, this would probe → dead → retry.
    const incidentalUrl = "http://127.0.0.1:1/apps/some-skill/index.html";
    const narration = `Done. While exploring I saw the skill references ${incidentalUrl} but I just wrote the three files to ./notes/.`;

    const result = await annotateUnverifiedUrls(
      narration,
      undefined,
      referenceText,
      undefined,
      undefined,
      undefined, // no routeVerification: the task set up no deployment
    );

    // The gate short-circuits: text is returned untouched, nothing flagged.
    expect(result.dead).toEqual([]);
    expect(result.verifiedUrls).toEqual([]);
    expect(result.text).toBe(narration);
    expect(result.text).not.toContain("verification:");
  });

  it("does NOT verify the EXACT reported case: 'build a static site in its own folder' with an incidental /apps/ URL in narration", async () => {
    // This is the precise regression. The reference text contains the generic
    // authoring words 'build', 'static', and 'site' — which the OLD broad
    // predicate matched — but the task requested NO reachable artifact / URL
    // and set up NO deployment route. An incidental dead /apps/<slug>/ URL the
    // sub-agent grepped from skill code must NOT be probed (and must not
    // trigger the 'something glitched, give me another go' retry).
    const referenceText = "build a static site in its own folder";
    const incidentalUrl = "http://127.0.0.1:1/apps/some-skill/index.html";
    const narration = `Built the static site in ./my-site/. (the skill at ${incidentalUrl} was a reference)`;

    const result = await annotateUnverifiedUrls(
      narration,
      undefined,
      referenceText,
      undefined,
      undefined,
      undefined,
    );

    expect(result.dead).toEqual([]);
    expect(result.verifiedUrls).toEqual([]);
    expect(result.text).toBe(narration);
    expect(result.text).not.toContain("verification:");
  });

  it("does NOT verify even a routed-shape URL with no route mapping for a non-artifact task", async () => {
    // Same shape as above but the URL would 404 on a real server. The key is
    // that with no route mapping AND no reachable-artifact intent, we never
    // even build the probe list.
    const referenceText = "summarize the contents of config.json";
    const incidentalUrl = "http://127.0.0.1:1/apps/telemetry/report";
    const narration = `Summary done. (note: the file mentions a callback to ${incidentalUrl})`;

    const result = await annotateUnverifiedUrls(
      narration,
      undefined,
      referenceText,
      undefined,
      undefined,
      undefined,
    );

    expect(result.dead).toEqual([]);
    expect(result.verifiedUrls).toEqual([]);
    expect(result.text).toBe(narration);
  });

  it("does NOT verify a user-supplied INPUT/source URL when no reachable artifact was requested", async () => {
    // "summarize https://example.com/docs" — the URL is an INPUT to read, not a
    // deliverable. The completion does not claim to host anything there. Even
    // though the task text contains a URL, this must NOT trigger verification
    // (the URL is not artifact-shaped and there's no deploy intent), so a
    // dead/unreachable input URL never causes a false retry.
    const referenceText = "summarize https://example.com/some-doc-page";
    const narration =
      "Summary: the page covers three topics: setup, usage, and FAQ.";

    const result = await annotateUnverifiedUrls(
      narration,
      undefined,
      referenceText,
      undefined,
      undefined,
      undefined,
    );

    expect(result.dead).toEqual([]);
    expect(result.verifiedUrls).toEqual([]);
    expect(result.text).toBe(narration);
    expect(result.text).not.toContain("verification:");
  });

  it.each([
    "summarize this URL: https://example.com/some-doc-page",
    "read the link https://example.com/some-doc-page and tell me what it says",
    "fetch this endpoint and report back: https://example.com/api/data",
  ])("does NOT verify INPUT-URL phrasing containing url/link/endpoint words: %s", async (referenceText) => {
    // The words "URL", "link", and "endpoint" are ambiguous and must NOT, on
    // their own, mark a plain (non-artifact-shaped) input URL as a verifiable
    // deliverable. Only hosting/serving/reachability/verify intent or an
    // artifact-SHAPED URL counts. These input-fetch tasks must never probe
    // their source URL or trigger a retry.
    const narration = "Done. Here is the summary you asked for.";
    const result = await annotateUnverifiedUrls(
      narration,
      undefined,
      referenceText,
      undefined,
      undefined,
      undefined,
    );

    expect(result.dead).toEqual([]);
    expect(result.verifiedUrls).toEqual([]);
    expect(result.text).toBe(narration);
    expect(result.text).not.toContain("verification:");
  });

  it("does NOT verify a CONSUME request that names an /apps/-shaped SOURCE url", async () => {
    // "summarize https://example.com/apps/foo/" — the URL is an input SOURCE the
    // agent reads, and it merely happens to have an /apps/ path. A consume
    // request must never verify its source URL, regardless of path shape.
    const referenceText = "summarize https://example.com/apps/foo/";
    const narration = "Summary: the page lists three sections.";
    const result = await annotateUnverifiedUrls(
      narration,
      undefined,
      referenceText,
      undefined,
      undefined,
      undefined,
    );
    expect(result.dead).toEqual([]);
    expect(result.verifiedUrls).toEqual([]);
    expect(result.text).toBe(narration);
  });

  describe("legitimate deploy task still verifies", () => {
    let server: Server;
    let port: number;
    let mode: "200" | "404" = "404";

    beforeEach(async () => {
      mode = "404";
      server = createServer((_req, res) => {
        if (mode === "404") {
          res.writeHead(404, { "content-type": "text/plain" });
          res.end("not found");
          return;
        }
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<!doctype html><title>ok</title><h1>ok</h1>");
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", () => resolve()),
      );
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("no addr");
      port = addr.port;
    });
    afterEach(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it("DOES verify + flag a dead URL when the user asked to be GIVEN the url (no deploy keyword)", async () => {
      // "create a landing page and give me the url" — a PROVIDE-url request with
      // NO deploy/host/live keyword. The agent claims a dead URL; it must still
      // be verified + flagged (codex review: preserve explicit-url-request
      // verification).
      const referenceText = "create a landing page and give me the url";
      const deadUrl = `http://127.0.0.1:${port}/landing/`;
      const narration = `Here you go: ${deadUrl}`;
      const result = await annotateUnverifiedUrls(
        narration,
        undefined,
        referenceText,
        undefined,
        undefined,
        undefined,
      );
      expect(result.dead.some((d) => d.url === deadUrl)).toBe(true);
      expect(result.text).toContain("verification:");
    });

    it("DOES verify a dead deployment URL for a MIXED read-source + deploy-output task", async () => {
      // The task both CONSUMES a source URL and explicitly asks to DEPLOY an
      // output + give the live URL. Explicit deploy intent is authoritative and
      // must not be suppressed by the consume signal (codex review).
      const deadUrl = `http://127.0.0.1:${port}/summary/`;
      const referenceText =
        "read https://example.com/source, deploy a summary page, and give me the live url";
      const narration = `Read the source and deployed. Live at ${deadUrl}`;
      const result = await annotateUnverifiedUrls(
        narration,
        undefined,
        referenceText,
        undefined,
        undefined,
        undefined,
      );
      expect(result.dead.some((d) => d.url === deadUrl)).toBe(true);
      expect(result.text).toContain("verification:");
    });

    it("DOES verify + flag a dead URL when the task explicitly requested a deployed live URL", async () => {
      // Task language contains "deploy"/"live"/"url" → reachable-artifact intent
      // is true → verification runs → the dead (404) URL is flagged so the
      // parent does not falsely tell the user it is live.
      const referenceText = "deploy the landing page and give me the live url";
      const deadUrl = `http://127.0.0.1:${port}/apps/landing/`;
      const narration = `Done — the app is live at ${deadUrl}`;

      const result = await annotateUnverifiedUrls(
        narration,
        undefined,
        referenceText,
        undefined,
        undefined,
        undefined,
      );

      expect(result.dead.length).toBeGreaterThan(0);
      expect(result.dead.some((d) => d.url === deadUrl)).toBe(true);
      expect(result.text).toContain("verification:");
    });

    it("routed non-deploy task: a route-HINT URL in the reference does NOT trigger verification of incidental narration URLs", async () => {
      // A ROUTED session augments the initial task with the real injected route
      // hints (which literally contain the word "URL" and a route-prefix URL)
      // ABOVE the verbatim user task under the '--- User Task ---' marker. The
      // verifier must read intent ONLY from the user-task slice, so the injected
      // hint never counts as a request for a reachable artifact. The task did
      // not ask for a reachable artifact, and the incidental dead URL in the
      // narration does NOT match the route mapping → no verification, no retry.
      const routeHintPrefix = `http://127.0.0.1:${port}/`;
      const referenceText = [
        "--- URL Path Mapping ---",
        "These mappings are authoritative for hosted artifacts:",
        `- URL prefix ${routeHintPrefix} maps to local path . under the resolved workdir.`,
        "--- User Task ---",
        "organize the notes folder",
      ].join("\n");
      const incidentalDeadUrl = "http://127.0.0.1:1/apps/some-skill/index.html";
      const narration = `Organized ./notes/. (saw ${incidentalDeadUrl} referenced in a skill)`;
      const routeVerification: RouteUrlVerification = {
        workdir: "/tmp/nonexistent",
        sessionStartedAtMs: Date.now(),
        mappings: [{ urlPrefix: routeHintPrefix, localPath: "." }],
      };

      const result = await annotateUnverifiedUrls(
        narration,
        undefined,
        referenceText,
        undefined,
        undefined,
        routeVerification,
      );

      // The incidental URL does not match the route mapping and the task did
      // not request a reachable artifact, so nothing is probed.
      expect(result.dead).toEqual([]);
      expect(result.text).not.toContain("verification:");
    });

    it("DOES verify a URL that matches an explicit route mapping the task set up (even with a non-artifact task)", async () => {
      // No reachable-artifact language in the reference, BUT the session has a
      // route mapping (the task configured a deployment). A completion URL that
      // targets that mapping IS a deliverable and must be verified.
      const referenceText = "ship it";
      const deadUrl = `http://127.0.0.1:${port}/apps/widget/`;
      const narration = `Shipped: ${deadUrl}`;
      const routeVerification: RouteUrlVerification = {
        workdir: "/tmp/nonexistent",
        sessionStartedAtMs: Date.now(),
        mappings: [
          {
            urlPrefix: `http://127.0.0.1:${port}/`,
            localPath: ".",
          },
        ],
      };

      const result = await annotateUnverifiedUrls(
        narration,
        undefined,
        referenceText,
        undefined,
        undefined,
        routeVerification,
      );

      expect(result.dead.some((d) => d.url === deadUrl)).toBe(true);
    });

    it("ROUTED session: a deploy-intent USER task still flags a dead EXTERNAL deployment URL not under the route prefix", async () => {
      // The user explicitly asked to deploy and get a live URL. The agent claims
      // an EXTERNAL deployment URL (e.g. a Vercel/Pages host) that does NOT fall
      // under the local route prefix. Reading intent from the user-task slice
      // (not the injected route hint) must keep verifying the claimed third-party
      // URL, so a dead deployment is still flagged — even in a routed session.
      const localPrefix = `http://127.0.0.1:${port}/`;
      const deadExternalUrl = `http://127.0.0.1:${port}/deployed-site/`;
      const referenceText = [
        "--- URL Path Mapping ---",
        `- URL prefix ${localPrefix} maps to local path . under the resolved workdir.`,
        "--- User Task ---",
        "deploy this to the host and give me the live url",
      ].join("\n");
      const narration = `Deployed. Live at ${deadExternalUrl}`;
      const routeVerification: RouteUrlVerification = {
        workdir: "/tmp/nonexistent",
        sessionStartedAtMs: Date.now(),
        mappings: [{ urlPrefix: localPrefix, localPath: "." }],
      };

      const result = await annotateUnverifiedUrls(
        narration,
        undefined,
        referenceText,
        undefined,
        undefined,
        routeVerification,
      );

      expect(result.dead.some((d) => d.url === deadExternalUrl)).toBe(true);
      expect(result.text).toContain("verification:");
    });
  });
});
