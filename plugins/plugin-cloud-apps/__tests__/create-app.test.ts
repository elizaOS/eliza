/**
 * CREATE_APP tests covering the pure parseCreateAppIntent parser and the action end to end. The @elizaos/cloud-sdk client is faked (helpers.ts, SDK boundary only); the action runs for real.
 */
import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { CreateAppInput } from "@elizaos/cloud-sdk";
import {
  captureCallback,
  FakeElizaCloudClient,
  keyedRuntime,
  makeApp,
  makeMessage,
  resetSdk,
  setCreateApp,
  unkeyedRuntime,
} from "./helpers";

mock.module("@elizaos/cloud-sdk", () => ({
  ElizaCloudClient: FakeElizaCloudClient,
}));

const { createAppAction, parseCreateAppIntent, DRAFT_APP_URL } = await import(
  "../src/actions/create-app.ts"
);

describe("parseCreateAppIntent", () => {
  it("extracts a name from natural phrasing", () => {
    expect(parseCreateAppIntent("build me an app called Acme Bot").name).toBe(
      "Acme Bot",
    );
    expect(parseCreateAppIntent("make a bot named Zephyr please").name).toBe(
      "Zephyr",
    );
    expect(parseCreateAppIntent('create an app "Side Project"').name).toBe(
      "Side Project",
    );
  });

  it("prefers an explicit planner option over the text", () => {
    const intent = parseCreateAppIntent("make something", { name: "Widget" });
    expect(intent.name).toBe("Widget");
  });

  it("detects monetization intent + markup percentage", () => {
    const intent = parseCreateAppIntent(
      "build a monetized app called Coin with 20% markup",
    );
    expect(intent.name).toBe("Coin");
    expect(intent.monetization).toBe(true);
    expect(intent.markupPercentage).toBe(20);
  });

  it("defaults monetization off and name null when absent", () => {
    const intent = parseCreateAppIntent("hello there");
    expect(intent.name).toBeNull();
    expect(intent.monetization).toBe(false);
    expect(intent.markupPercentage).toBeUndefined();
  });
});

describe("CREATE_APP", () => {
  beforeEach(() => {
    resetSdk();
  });

  it("validates only when a Cloud API key is present", async () => {
    expect(
      await createAppAction.validate(keyedRuntime(), makeMessage("x")),
    ).toBe(true);
    expect(
      await createAppAction.validate(unkeyedRuntime(), makeMessage("x")),
    ).toBe(false);
  });

  it("creates an app with the parsed name + draft url and offers to deploy", async () => {
    let received: CreateAppInput | null = null;
    setCreateApp((input) => {
      received = input;
      return Promise.resolve({
        success: true,
        app: makeApp({ id: "id-acme", name: "Acme Bot", slug: "acme-bot" }),
        apiKey: "eliza_app_secret_do_not_leak",
      });
    });

    const cb = captureCallback();
    const result = await createAppAction.handler(
      keyedRuntime(),
      makeMessage("build me an app called Acme Bot"),
      undefined,
      undefined,
      cb.fn,
    );

    expect(result?.success).toBe(true);
    expect(received).not.toBeNull();
    expect((received as unknown as CreateAppInput).name).toBe("Acme Bot");
    expect((received as unknown as CreateAppInput).app_url).toBe(DRAFT_APP_URL);
    // The front door MUST request a template app (skipGitHubRepo) so the server
    // stamps a deployable image — without this the create -> deploy loop throws
    // "build-from-repo is disabled / no image to deploy".
    expect((received as unknown as CreateAppInput).skipGitHubRepo).toBe(true);
    const reply = cb.calls[0]?.text ?? "";
    expect(reply).toContain("Acme Bot");
    expect(reply.toLowerCase()).toContain("deploy");
    // The one-time app API key must NOT be echoed into chat.
    expect(reply).not.toContain("eliza_app_secret_do_not_leak");
  });

  it("passes monetization intent through and relays the server's review downgrade (#11863)", async () => {
    // The server never enables monetization at create time: it creates the app
    // with monetization off, keeps the markup as a pricing default, and
    // returns the review requirement in `warnings`.
    const reviewWarning =
      "Monetization requires an approved app review, so the app was created with monetization disabled. Submit it for review (the Monetize tab in the dashboard, or POST /api/v1/apps/:id/review), then enable monetization after approval.";
    let received: CreateAppInput | null = null;
    setCreateApp((input) => {
      received = input;
      // The server would 403 `app_review_required` if we ever sent
      // monetization_enabled:true, so the created app is always un-monetized.
      return Promise.resolve({
        success: true,
        app: makeApp({
          name: "Coin",
          monetization_enabled: false,
          inference_markup_percentage: 20,
          review_status: "draft",
        }),
        apiKey: "k",
        warnings: [reviewWarning],
      });
    });

    const cb = captureCallback();
    const result = await createAppAction.handler(
      keyedRuntime(),
      makeMessage("create a monetized app called Coin with 20% markup"),
      undefined,
      undefined,
      cb.fn,
    );

    const body = received as unknown as CreateAppInput;
    // NEVER send monetization_enabled at create — the API hard-403s it.
    expect(body.monetization_enabled).toBeUndefined();
    // Pricing defaults still flow through so they're ready post-approval.
    expect(body.inference_markup_percentage).toBe(20);

    // The app was still created — no dead 403 — and the reply surfaces the
    // review requirement without claiming monetization is on.
    expect(result?.success).toBe(true);
    const reply = cb.calls[0]?.text ?? "";
    expect(reply).toContain("Coin");
    expect(reply).toContain(reviewWarning);
    expect(reply).not.toContain("Monetization is on");
    // The success reply also tells the user how to monetize it: submit for
    // review, then enable after approval.
    expect(reply.toLowerCase()).toContain("review");
    expect(reply).toContain("/api/v1/apps/:id/review");
    expect(reply.toLowerCase()).toContain("monetization");
    expect(result?.data).toMatchObject({
      monetization: false,
      reviewStatus: "draft",
    });
  });

  it("asks for a name when none can be parsed (no create call)", async () => {
    let called = false;
    setCreateApp((_input) => {
      called = true;
      return Promise.resolve({
        success: true,
        app: makeApp(),
        apiKey: "k",
      });
    });

    const cb = captureCallback();
    const result = await createAppAction.handler(
      keyedRuntime(),
      makeMessage("make me something cool"),
      undefined,
      undefined,
      cb.fn,
    );

    expect(result?.success).toBe(false);
    expect((result?.data as { reason: string }).reason).toBe("no_name");
    expect(called).toBe(false);
    expect(cb.calls[0]?.text?.toLowerCase()).toContain("what should i call");
  });

  it("degrades gracefully with no Cloud API key", async () => {
    const cb = captureCallback();
    const result = await createAppAction.handler(
      unkeyedRuntime(),
      makeMessage("build an app called X"),
      undefined,
      undefined,
      cb.fn,
    );
    expect(result?.success).toBe(false);
    expect((result?.data as { reason: string }).reason).toBe("no_key");
  });

  it("handles a Cloud API error without throwing", async () => {
    setCreateApp(() => Promise.reject(new Error("boom")));
    const cb = captureCallback();
    const result = await createAppAction.handler(
      keyedRuntime(),
      makeMessage("build an app called Acme"),
      undefined,
      undefined,
      cb.fn,
    );
    expect(result?.success).toBe(false);
    expect((result?.data as { reason: string }).reason).toBe("error");
  });
});
