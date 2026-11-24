// spec/os/signIn/readiness.md, "Story: Show only the methods the cloud is ready for"; spec/os/signIn/readiness.md, "Story: Read the service's own terms"
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import * as spec from "../gen/os__signIn__readiness.ts";
import { compileAdapter, orgJsonAdapterClasspath } from "./drivers/jvm-adapter.ts";
import { expectCasesAgree, javaTool, type Case } from "./support/law-cases.ts";

function javaLines(main: string, classpath: string = compileAdapter(main)): unknown[] {
  const out = execFileSync(javaTool("java"), ["-cp", classpath, main], { encoding: "utf8", maxBuffer: 1 << 28, timeout: 120_000 });
  return out.split("\n").filter(Boolean).map((line) => JSON.parse(line) as unknown);
}

async function journey(): Promise<ReadonlyMap<string, unknown>> {
  const main = "ai.eliza.plugins.signin.ReadinessJourney";
  const lines = javaLines(main, await orgJsonAdapterClasspath(main)) as { step: string; value: unknown }[];
  return new Map(lines.map((line) => [line.step, line.value]));
}

const seen = (methods: { email: boolean; sms: boolean; google: boolean }) => ({ methodsKnown: true, ...methods });

describe("Show only the methods the cloud is ready for", () => {
  it("answers as the generated spec does over every value the spec names", () => {
    const cases = javaLines("ai.eliza.plugins.signin.ReadinessLawCheck") as Case[];
    const functions = spec as unknown as Record<string, (...args: unknown[]) => unknown>;
    const names = new Set(cases.map((c) => c.fn));
    expect(cases.length).toBeGreaterThan(1000);
    expect([...names].filter((name) => typeof functions[name] !== "function")).toEqual([]);
    expectCasesAgree(cases, (c) => functions[c.fn](...c.args));
    const opened = (handlers: readonly string[]) => cases.filter((c) => c.fn === "browserToOpen" && JSON.stringify(c.args[0]) === JSON.stringify(handlers)).map((c) => c.result);
    expect(new Set(opened(["ai.example.phone", "org.chromium.webview_shell"]))).toEqual(new Set([""]));
    expect(new Set(opened(["org.chromium.webview_shell", "com.android.chrome"]))).toEqual(new Set(["com.android.chrome"]));
  });

  it("serves a fresh answer at once, measures behind it, keeps it through no reading and announces only a change", async () => {
    const steps = await journey();
    expect(["registration-no-client", "registration-test-environment-not-enabled", "registration-plain-http", "registration-no-production",
      "registration-shared-origin", "registration-hosted-mode"].map((step) => steps.get(step))).toEqual(Array(6).fill("refused"));
    expect(steps.get("registration-valid")).toBe("accepted");
    expect(steps.get("load-probes")).toEqual([1, 1]);
    expect(steps.get("load-query")).toBe("/api/v1/app-auth/mobile/config?clientId=ai.example.phone&environment=production&redirectUri=https%3A%2F%2Fapp.cloud.test%2Fauth%2Fproduction");
    expect(steps.get("first-answer-announced")).toBe(0);
    expect(steps.get("fresh-served")).toEqual(seen({ email: true, sms: false, google: true }));
    expect(steps.get("fresh-probes")).toBe(0);
    expect([steps.get("recheck-served-count"), steps.get("recheck-probes"), steps.get("unchanged-announced")]).toEqual([2, 1, 0]);
    expect(steps.get("no-reading-probes")).toBe(2);
    expect(steps.get("no-reading-keeps-after")).toEqual(seen({ email: true, sms: false, google: true }));
    expect(steps.get("no-reading-announced")).toBe(0);
    expect(steps.get("changed-announced")).toEqual({ environment: "production", ...seen({ email: true, sms: true, google: true }) });
    expect(steps.get("changed-announced-count")).toBe(1);
    expect([steps.get("complete-probes"), steps.get("expired-probes")]).toEqual([0, 1]);
    expect(steps.get("refused-client")).toEqual(seen({ email: false, sms: false, google: false }));
    expect(steps.get("refused-client-announced")).toEqual({ environment: "production", ...seen({ email: false, sms: false, google: false }) });
    expect(steps.get("unknown-environment")).toBe(false);
    expect([steps.get("resume-without-screen-probes"), steps.get("resume-after-screen-probes")]).toEqual([0, 1]);
    expect(steps.get("browser-unverified")).toEqual(seen({ email: true, sms: true, google: false }));
    expect(steps.get("browser-verified")).toEqual(seen({ email: true, sms: true, google: true }));
    expect(steps.get("browser-shell-only")).toEqual(seen({ email: true, sms: true, google: false }));
    expect(steps.get("browser-full")).toEqual(seen({ email: true, sms: true, google: true }));
    expect(steps.get("browser-change-probes")).toBe(0);
    expect(steps.get("browser-choice")).toEqual(["browser.default", "browser.other", "null"]);
  });
});

describe("Read the service's own terms", () => {
  it("is read only from the registered environment's API origin and shown as received, or reported unavailable", async () => {
    const steps = await journey();
    expect(steps.get("service-origins")).toEqual(["https://staging-api.cloud.test"]);
    expect(steps.get("service-body")).toEqual(steps.get("service-expected-document"));
    expect(steps.get("service-outcomes")).toEqual(["SERVICE_SHOWN", "SERVICE_UNAVAILABLE", "SERVICE_UNAVAILABLE", "SERVICE_UNKNOWN_ENVIRONMENT"]);
  });
});
