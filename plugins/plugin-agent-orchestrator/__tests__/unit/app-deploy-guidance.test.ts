/**
 * Verifies app-deploy-guidance.
 * Deterministic unit test of pure helpers; no runtime, no live model.
 */
import { describe, expect, it } from "vitest";
import {
  augmentTaskWithDeployGuidance,
  buildAppDeployGuidance,
  isAppBuildTask,
  isMonetizedAppTask,
} from "../../src/services/app-deploy-guidance.js";

describe("app-deploy-guidance", () => {
  // The planner's `monetized` signal is the STRUCTURAL fix for the normie
  // phrasings the keyword regex misses ("people pay $1 to chat with X"). It must
  // produce the monetized Eliza Cloud contract regardless of target, and even
  // when the build-verb gate (isAppBuildTask) would otherwise drop the task.
  describe("monetized signal (structural, not keyword)", () => {
    const cloud = { target: "eliza-cloud" as const };
    const custom = {
      target: "custom" as const,
      customAppsDir: "/data/apps",
      customBaseUrl: "https://example.test",
    };
    // The two flagship normie phrasings the regex does NOT catch.
    const NORMIE = [
      "build me an app where people pay $1 to chat with a grimes-style AI",
      "an app spending $1 to talk to a drake style ai",
    ];

    it("regex alone misses these normie phrasings (documents the gap)", () => {
      for (const p of NORMIE) expect(isMonetizedAppTask(p)).toBe(false);
    });

    it("eliza-cloud: signal forces the edad/register monetized contract", () => {
      for (const p of NORMIE) {
        const out = augmentTaskWithDeployGuidance(p, cloud, {
          monetized: true,
        });
        expect(out).toContain("App Deployment (Eliza Cloud)");
        expect(out).toContain("packages/examples/cloud/edad");
        // Broker-first (#14118): register via the parent broker command, not a
        // raw POST /api/v1/apps with an owner key the child no longer has.
        expect(out).toContain('"command":"apps.create"');
        expect(out).not.toContain("POST /api/v1/apps");
        expect(out).toContain("x-affiliate-code");
      }
    });

    it("eliza-cloud: signal forces the contract even when the build-verb gate misses", () => {
      // "an app spending $1 …" has no build verb → isAppBuildTask is false.
      expect(isAppBuildTask(NORMIE[1])).toBe(false);
      const out = augmentTaskWithDeployGuidance(NORMIE[1], cloud, {
        monetized: true,
      });
      expect(out).toContain("packages/examples/cloud/edad");
    });

    it("custom host: signal turns the weak conditional into a firm directive", () => {
      const plain = augmentTaskWithDeployGuidance(NORMIE[0], custom);
      expect(plain).toContain("If the app must earn money");
      expect(plain).not.toContain("THIS APP IS MONETIZED");

      const monetized = augmentTaskWithDeployGuidance(NORMIE[0], custom, {
        monetized: true,
      });
      expect(monetized).toContain("THIS APP IS MONETIZED");
      expect(monetized).toContain("packages/examples/cloud/edad");
      expect(monetized).toContain("x-app-id");
    });

    it("no signal + no keyword → free-app contract, NOT monetized (no regression)", () => {
      const out = augmentTaskWithDeployGuidance(
        "build me a free web app tip calculator",
        cloud,
      );
      expect(out).toContain("App Deployment (Eliza Cloud)");
      expect(out).not.toContain("packages/examples/cloud/edad");
    });

    it("signal only ADDS detection — a keyword match still works without it", () => {
      const out = buildAppDeployGuidance(
        cloud,
        "build a monetized app that charges $2 per use",
      );
      expect(out).toContain("packages/examples/cloud/edad");
    });
  });

  describe("isAppBuildTask", () => {
    it("matches hosted web-surface builds", () => {
      expect(isAppBuildTask("build me a website about cats")).toBe(true);
      expect(isAppBuildTask("create a landing page for my startup")).toBe(true);
      expect(isAppBuildTask("make a web app dashboard")).toBe(true);
    });

    it("does NOT match non-hosted builds (CLI / library / script / bot)", () => {
      expect(isAppBuildTask("build a CLI tool to parse logs")).toBe(false);
      expect(isAppBuildTask("create a npm library for dates")).toBe(false);
      expect(isAppBuildTask("write a script to rename files")).toBe(false);
      expect(isAppBuildTask("fix the bug in the parser")).toBe(false);
    });

    it("ignores empty/nullish input", () => {
      expect(isAppBuildTask("")).toBe(false);
      expect(isAppBuildTask(undefined)).toBe(false);
      expect(isAppBuildTask(null)).toBe(false);
    });
  });

  describe("isMonetizedAppTask", () => {
    it("matches money-earning app builds", () => {
      expect(isMonetizedAppTask("build a monetized web app")).toBe(true);
      expect(
        isMonetizedAppTask("an app that charges $2 per use with a markup"),
      ).toBe(true);
      expect(isMonetizedAppTask("a paid app with premium tiers")).toBe(true);
    });
    it("does NOT match a plain static/fun app", () => {
      expect(isMonetizedAppTask("build me a magic 8-ball web app")).toBe(false);
      expect(isMonetizedAppTask("a quick countdown timer page")).toBe(false);
      expect(isMonetizedAppTask("")).toBe(false);
    });
  });

  describe("custom-host publish note (structural, always attached)", () => {
    const cfg = {
      target: "custom" as const,
      customAppsDir: "/data/apps",
      customBaseUrl: "https://example.test",
    };
    it("attaches the self-gating publish note with both CREATE and EDIT paths", () => {
      const out = augmentTaskWithDeployGuidance(
        "build a magic 8-ball web app",
        cfg,
      );
      expect(out).toContain("Publishing web apps (custom host)");
      expect(out).toContain("To CREATE a new app");
      // The whole point of this PR: an existing deployed app can be edited in
      // place instead of being re-created under a fresh slug.
      expect(out).toContain("To EDIT an existing app");
      expect(out).toContain("/data/apps/<slug>/");
      expect(out).toContain("https://example.test/apps/<slug>/");
      expect(out).toContain(
        "If your task is not a web app, ignore this section",
      );
    });
    it("routes monetization through the build-monetized-app skill, not an edad/cloud.json branch", () => {
      const out = augmentTaskWithDeployGuidance(
        "build a monetized web app that charges $3 per use",
        cfg,
      );
      expect(out).toContain("Publishing web apps (custom host)");
      expect(out).toContain("also register it with Eliza Cloud");
      expect(out).toContain("build-monetized-app");
      // The old monetized-vs-static branching (edad template, cloud.json,
      // "Do NOT use Eliza Cloud for this one") is gone — the note is now a
      // single structural capability description the model applies by judgment.
      expect(out).not.toContain("App Deployment (Eliza Cloud)");
      expect(out).not.toContain("packages/examples/cloud/edad");
      expect(out).not.toContain("cloud.json");
      expect(out).not.toContain("Do NOT use Eliza Cloud for this one");
    });
    it("is attached structurally, even to a task the old keyword regex would not match as an app build", () => {
      // "add a dark mode toggle and redeploy it" never matched isAppBuildTask's
      // build-verb pattern, so the agent previously got no apps-dir context and
      // could not find the deployed app. The note is now always present.
      const out = augmentTaskWithDeployGuidance(
        "add a dark mode toggle to the coinflip app and redeploy it",
        cfg,
      );
      expect(out).toContain("Publishing web apps (custom host)");
      expect(out).toContain("Otherwise do not involve Eliza Cloud");
      expect(out).not.toContain("App Deployment (Eliza Cloud)");
    });
    it("appends operator-supplied publish notes verbatim, and omits them when unset", () => {
      // Host-specific caveats (e.g. "do not run the host's build script") live
      // only in the operator's private config — never hardcoded here.
      const note = "- Do NOT run the host build script for static apps.";
      const withNotes = augmentTaskWithDeployGuidance("build a web app", {
        ...cfg,
        customPublishNotes: note,
      });
      expect(withNotes).toContain(note);
      const withoutNotes = augmentTaskWithDeployGuidance(
        "build a web app",
        cfg,
      );
      expect(withoutNotes).not.toContain(note);
    });
  });

  describe("augmentTaskWithDeployGuidance", () => {
    it("appends the Eliza Cloud contract to an app-build task by default", () => {
      const out = augmentTaskWithDeployGuidance("build a website about cats", {
        target: "eliza-cloud",
      });
      expect(out).toContain("build a website about cats");
      expect(out).toContain("App Deployment (Eliza Cloud)");
      expect(out).toContain("verified live");
    });

    it("passes a non-app task through unchanged", () => {
      const task = "fix the bug in the parser";
      expect(
        augmentTaskWithDeployGuidance(task, { target: "eliza-cloud" }),
      ).toBe(task);
    });

    it("is idempotent — does not double-append the contract", () => {
      const once = augmentTaskWithDeployGuidance("build a website", {
        target: "eliza-cloud",
      });
      const twice = augmentTaskWithDeployGuidance(once, {
        target: "eliza-cloud",
      });
      expect(twice).toBe(once);
    });

    it("uses the gated custom host when that target is configured", () => {
      const out = augmentTaskWithDeployGuidance("build a website", {
        target: "custom",
        customAppsDir: "/data/apps",
        customBaseUrl: "https://example.test",
      });
      expect(out).toContain("Publishing web apps (custom host)");
      expect(out).toContain("/data/apps/<slug>/");
      expect(out).toContain("https://example.test/apps/<slug>/");
      // The Cloud contract header must not appear — the custom-host note only
      // references Cloud conditionally for the monetized case.
      expect(out).not.toContain("App Deployment (Eliza Cloud)");
    });
  });

  describe("buildAppDeployGuidance", () => {
    it("a MONETIZED Eliza-Cloud build starts from the edad template (no from-scratch)", () => {
      const out = buildAppDeployGuidance(
        { target: "eliza-cloud" },
        "build a monetized app that charges $2 per use",
      );
      expect(out).toContain("packages/examples/cloud/edad");
      expect(out).toContain("START FROM THE TEMPLATE");
      // forwards to the org-balance endpoint, not the stranded per-app pool
      expect(out).toContain("/api/v1/messages");
      expect(out).not.toContain("/api/v1/apps/<appId>/chat");
    });
    it("a NON-monetized build keeps the generic Cloud contract (no edad)", () => {
      const out = buildAppDeployGuidance(
        { target: "eliza-cloud" },
        "build a website about cats",
      );
      expect(out).toContain("App Deployment (Eliza Cloud)");
      expect(out).not.toContain("packages/examples/cloud/edad");
    });
    it("defaults to Eliza Cloud for an unspecified/empty config", () => {
      expect(buildAppDeployGuidance({ target: "eliza-cloud" })).toContain(
        "Eliza Cloud",
      );
    });
    // The push step of the container flow: an anonymous ghcr.io push always
    // 403s, so BOTH cloud branches must carry the docker-login contract (env
    // var NAMES only — never values) and the explicit report-the-missing-
    // credential instruction instead of a silent/vague failure.
    it("both Cloud branches carry the registry login contract by env-var name", () => {
      for (const task of [
        "build a monetized app that charges $2 per use",
        "build a website about cats",
      ]) {
        const out = buildAppDeployGuidance({ target: "eliza-cloud" }, task);
        expect(out).toContain("docker login ghcr.io");
        expect(out).toContain("ELIZA_APP_IMAGE_REGISTRY_USERNAME");
        expect(out).toContain("ELIZA_APP_IMAGE_REGISTRY_TOKEN");
        expect(out).toContain("GHCR_TOKEN");
        expect(out).toContain("registry push credential is missing");
      }
    });
  });

  // #14118: Cloud register + deploy render as parent-agent BROKER commands, not
  // raw Cloud-API curls with an owner key the child no longer receives. The
  // broker commands map 1:1 onto the edad README's calls (apps.create → POST
  // /api/v1/apps, containers.create → POST /api/v1/containers) and keep the
  // spend cap + human-confirmation gates. The one value the broker can't inject —
  // the container's own ELIZA_CLOUD_API_KEY runtime bearer — is fetched via the
  // owner-approved credential bridge, never a raw env leak.
  describe("broker-first Cloud access (#14118)", () => {
    const cloud = { target: "eliza-cloud" as const };

    it("monetized build routes register + deploy through the broker, not raw curls", () => {
      const out = buildAppDeployGuidance(
        cloud,
        "build a monetized app that charges $2 per use",
      );
      expect(out).toContain('"command":"apps.create"');
      expect(out).toContain('"command":"containers.create"');
      // The parity anchor: broker containers.create == the edad README's
      // ungated POST /api/v1/containers. The guidance names the gated
      // /apps/<id>/deploy only to warn AGAINST it.
      expect(out).toContain("ungated container path");
      expect(out).toContain("do NOT use the gated `/apps/<id>/deploy`");
      // No raw Cloud-API POSTs are prescribed — the child does not curl the API.
      expect(out).not.toContain("POST /api/v1/apps");
      // The child is told it does not hold the raw owner key.
      expect(out).toContain("you have no raw Cloud key");
    });

    it("keeps the container-runtime key on the owner-approved credential bridge (the one step broker can't inject)", () => {
      const out = buildAppDeployGuidance(
        cloud,
        "build a monetized app that charges $2 per use",
      );
      // The container's own upstream bearer is a caller-supplied value; it is the
      // non-reserved ELIZA_CLOUD_API_KEY (ELIZAOS_CLOUD_API_KEY is platform-
      // reserved and rejected on the deploy path — #9853), fetched via the bridge.
      expect(out).toContain("environmentVars.ELIZA_CLOUD_API_KEY");
      expect(out).toContain("platform-reserved");
      expect(out).toContain("credentials/request");
      expect(out).toContain("ELIZA_FORWARD_CLOUD_KEY_TO_SUBAGENTS");
    });

    it("non-monetized build also routes hosting through the broker", () => {
      const out = buildAppDeployGuidance(cloud, "build a website about cats");
      // The non-monetized branch names the broker commands (backtick form) and
      // the JSON apps.create call, but never a raw Cloud-API POST.
      expect(out).toContain('"command":"apps.create"');
      expect(out).toContain("cloud-command containers.create");
      expect(out).toContain("through the PARENT AGENT");
      expect(out).not.toContain("POST /api/v1/apps");
    });
  });
});
