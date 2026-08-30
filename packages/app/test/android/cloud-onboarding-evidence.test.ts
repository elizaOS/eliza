/**
 * Exercises the deterministic redaction boundary used by the physical Android
 * Cloud-onboarding lane. These tests validate real wire-shaped URLs without
 * executing the operator- and device-gated Google flow.
 */
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  ANDROID_CLOUD_ONBOARDING_STILL_NAMES,
  applyAndroidCloudOnboardingDocumentBootstrap,
  buildAndroidCloudOnboardingBootstrapPlan,
  buildAndroidCloudOnboardingJpegArtifact,
  buildAndroidCloudResponseEvidence,
  extractAndroidCloudPkceHandoffEvidence,
  findAndroidGoogleProviderTapPoint,
  requirePhysicalAndroidDevice,
} from "./cloud-onboarding-evidence";

function mobilePkceLoginUrl(
  environment: "production" | "staging",
  options: {
    challenge?: string;
    state?: string;
    returnToOverride?: string;
  } = {},
): string {
  const origin =
    environment === "staging"
      ? "https://cloud-staging.eliza.app"
      : "https://cloud.eliza.app";
  const authorize = new URL("/app-auth/authorize", origin);
  authorize.searchParams.set("flow", "mobile_pkce");
  authorize.searchParams.set("client_id", "ai.elizaos.app");
  authorize.searchParams.set("environment", environment);
  authorize.searchParams.set("redirect_uri", "https://eliza.app/auth/callback");
  authorize.searchParams.set("state", options.state ?? "s".repeat(64));
  authorize.searchParams.set(
    "code_challenge",
    options.challenge ?? "c".repeat(43),
  );
  authorize.searchParams.set("code_challenge_method", "S256");
  authorize.searchParams.set("device_name", "Android");
  const login = new URL("/login", origin);
  login.searchParams.set(
    "returnTo",
    options.returnToOverride ?? `${authorize.pathname}${authorize.search}`,
  );
  return login.toString();
}

describe("Android Cloud-onboarding still evidence", () => {
  it("applies each storage reset once and preserves the callback credential on reload", () => {
    const values = new Map<string, string>([
      ["elizaos:active-server", "stale-local-agent"],
      ["eliza:e2e-wallet:pk", "stale-wallet"],
      ["unrelated-preference", "keep"],
    ]);
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      removeItem: (key: string) => values.delete(key),
      setItem: (key: string, value: string) => values.set(key, value),
    };
    const plan = buildAndroidCloudOnboardingBootstrapPlan("a".repeat(32), {
      switchAccount: true,
    });
    let visibleUrl = plan.navigationPath;
    const firstRuntime = {
      href: `https://localhost${visibleUrl}`,
      replaceUrl: (value: string) => {
        visibleUrl = value;
      },
      storage,
    };

    expect(
      applyAndroidCloudOnboardingDocumentBootstrap(plan, firstRuntime),
    ).toBe(true);
    expect(values.get("elizaos:active-server")).toBeUndefined();
    expect(values.get("eliza:e2e-wallet:pk")).toBeUndefined();
    expect(values.get("eliza:android-cloud:account-switch-pending:v1")).toBe(
      "1",
    );
    expect(values.get("unrelated-preference")).toBe("keep");
    expect(visibleUrl).toBe("/");

    // The real callback stores this through Android secure storage. Model its
    // visible cache entry after the one-shot bootstrap has consumed its token:
    // the retained init script must be inert on the credential-verifying reload.
    values.set("steward_session_token", "callback-mobile-credential");
    expect(
      applyAndroidCloudOnboardingDocumentBootstrap(plan, {
        ...firstRuntime,
        href: `https://localhost${visibleUrl}`,
      }),
    ).toBe(false);
    expect(values.get("steward_session_token")).toBe(
      "callback-mobile-credential",
    );
  });

  it("rejects ambiguous bootstrap URLs and malformed reset tokens", () => {
    expect(() => buildAndroidCloudOnboardingBootstrapPlan("short")).toThrow(
      /128-bit lowercase hex/,
    );
    const plan = buildAndroidCloudOnboardingBootstrapPlan("b".repeat(32));
    const values = new Map([["steward_session_token", "keep"]]);
    const runtime = {
      href: `https://localhost${plan.navigationPath}&${plan.queryKey}=${plan.token}`,
      replaceUrl: () => {
        throw new Error("ambiguous bootstrap must not rewrite the URL");
      },
      storage: {
        getItem: (key: string) => values.get(key) ?? null,
        removeItem: (key: string) => values.delete(key),
        setItem: (key: string, value: string) => values.set(key, value),
      },
    };

    expect(applyAndroidCloudOnboardingDocumentBootstrap(plan, runtime)).toBe(
      false,
    );
    expect(values.get("steward_session_token")).toBe("keep");
  });

  it("accepts only a physical ADB target and emits no device identifier", () => {
    const receipt = requirePhysicalAndroidDevice("RF8N30ABCDE", "\n");
    expect(receipt).toEqual({
      deviceClass: "physical",
      emulatorSerialPattern: false,
      kernelQemuTruthy: false,
    });
    expect(JSON.stringify(receipt)).not.toContain("RF8N30ABCDE");

    expect(() => requirePhysicalAndroidDevice("emulator-5554", "0")).toThrow(
      /physical device.*emulator-style ADB serial/i,
    );
    for (const truthyProperty of ["1", "true", "yes", "qemu"]) {
      expect(() =>
        requirePhysicalAndroidDevice("RF8N30ABCDE", truthyProperty),
      ).toThrow(/ro\.kernel\.qemu reports an emulator/i);
    }
    for (const falseProperty of ["0", "false", "no", "off"]) {
      expect(
        requirePhysicalAndroidDevice("RF8N30ABCDE", falseProperty),
      ).toEqual(receipt);
    }
  });

  it("emits greeting, authenticated home, and live-reply captures as JPEG artifacts", () => {
    expect(ANDROID_CLOUD_ONBOARDING_STILL_NAMES).toEqual([
      "sign-in-greeting",
      "home-landing",
      "reply-liveness",
    ]);

    for (const name of ANDROID_CLOUD_ONBOARDING_STILL_NAMES) {
      const artifact = buildAndroidCloudOnboardingJpegArtifact(
        "/evidence/android/tap",
        name,
      );
      expect(path.basename(artifact.screenshot.path)).toBe(`${name}.jpg`);
      expect(artifact.screenshot).toMatchObject({
        fullPage: true,
        type: "jpeg",
      });
      expect(artifact.attachment).toEqual({
        path: artifact.screenshot.path,
        contentType: "image/jpeg",
      });
    }
  });

  it("validates production and staging mobile-PKCE handoffs without returning bindings", () => {
    const state = "s".repeat(64);
    const challenge = "c".repeat(43);
    const productionUrl = mobilePkceLoginUrl("production", {
      state,
      challenge,
    });
    const production = extractAndroidCloudPkceHandoffEvidence(
      `pluginId: Browser, url: "${productionUrl.replaceAll("/", "\\/")}"`,
    );
    expect(production).toEqual({
      authorizePath: "/app-auth/authorize",
      browserHost: "cloud.eliza.app",
      codeChallengeShapeValid: true,
      clientId: "ai.elizaos.app",
      codeChallengeMethod: "S256",
      deviceName: "Android",
      environment: "production",
      redirectUri: "https://eliza.app/auth/callback",
      stateShapeValid: true,
      switchAccount: false,
    });
    expect(JSON.stringify(production)).not.toContain(state);
    expect(JSON.stringify(production)).not.toContain(challenge);

    const stagingUrl = new URL(mobilePkceLoginUrl("staging"));
    stagingUrl.searchParams.set("switchAccount", "1");
    expect(
      extractAndroidCloudPkceHandoffEvidence(stagingUrl.toString()),
    ).toMatchObject({
      browserHost: "cloud-staging.eliza.app",
      environment: "staging",
      switchAccount: true,
    });
  });

  it("rejects legacy, cross-origin, incomplete, and ambiguous handoffs", () => {
    const missingChallenge = new URL(mobilePkceLoginUrl("production"));
    const missingChallengeReturn = new URL(
      missingChallenge.searchParams.get("returnTo") ?? "",
      missingChallenge.origin,
    );
    missingChallengeReturn.searchParams.delete("code_challenge");
    missingChallenge.searchParams.set(
      "returnTo",
      `${missingChallengeReturn.pathname}${missingChallengeReturn.search}`,
    );

    const duplicateReturn = new URL(mobilePkceLoginUrl("production"));
    duplicateReturn.searchParams.append(
      "returnTo",
      "/app-auth/authorize?flow=mobile_pkce",
    );

    for (const value of [
      "https://cloud.eliza.app/auth/cli-login?session=legacy",
      mobilePkceLoginUrl("production", {
        returnToOverride:
          "https://attacker.example/app-auth/authorize?flow=mobile_pkce",
      }),
      missingChallenge.toString(),
      duplicateReturn.toString(),
      mobilePkceLoginUrl("production", { state: "short" }),
    ]) {
      expect(extractAndroidCloudPkceHandoffEvidence(value)).toBeNull();
    }
  });

  it("reduces the Android accessibility hierarchy to the Google tap point", () => {
    const privateEmail = "device-owner@example.test";
    const hierarchy = `<hierarchy>
      <node text="${privateEmail}" bounds="[0,0][300,80]" />
      <node text="Google" content-desc="" clickable="true" enabled="true" bounds="[24,400][456,520]" />
    </hierarchy>`;
    const point = findAndroidGoogleProviderTapPoint(hierarchy);
    expect(point).toEqual({ x: 240, y: 460 });
    expect(JSON.stringify(point)).not.toContain(privateEmail);
    expect(
      findAndroidGoogleProviderTapPoint(
        '<node text="Discord" clickable="true" bounds="[24,400][456,520]" />',
      ),
    ).toBeNull();
    expect(
      findAndroidGoogleProviderTapPoint(
        '<node text="Google" clickable="false" enabled="true" bounds="[24,400][456,520]" />',
      ),
    ).toBeNull();
    expect(
      findAndroidGoogleProviderTapPoint(
        '<node text="Google" clickable="true" enabled="false" bounds="[24,400][456,520]" />',
      ),
    ).toBeNull();
  });

  it("reduces auth, identity, and streamed-chat responses without route identifiers", () => {
    expect(
      buildAndroidCloudResponseEvidence(
        "https://api.eliza.app/api/v1/app-auth/mobile/config?clientId=ai.elizaos.app",
        "GET",
        200,
      ),
    ).toEqual({ method: "GET", phase: "mobile-config", status: 200 });
    expect(
      buildAndroidCloudResponseEvidence(
        "https://api.eliza.app/api/v1/app-auth/mobile/token",
        "POST",
        201,
      ),
    ).toEqual({ method: "POST", phase: "mobile-token", status: 201 });
    expect(
      buildAndroidCloudResponseEvidence(
        "https://api.eliza.app/api/v1/app-auth/mobile/ack",
        "POST",
        200,
      ),
    ).toEqual({ method: "POST", phase: "mobile-ack", status: 200 });
    expect(
      buildAndroidCloudResponseEvidence(
        "https://api-staging.eliza.app/api/v1/eliza/personal",
        "GET",
        200,
      ),
    ).toEqual({ method: "GET", phase: "personal-agent", status: 200 });

    const conversationId = "private-conversation-id";
    const streamed = buildAndroidCloudResponseEvidence(
      `https://123e4567-e89b-42d3-a456-426614174000.cloud.eliza.app/api/conversations/${conversationId}/messages/stream`,
      "POST",
      200,
    );
    expect(streamed).toEqual({
      method: "POST",
      phase: "message-stream",
      status: 200,
    });
    expect(JSON.stringify(streamed)).not.toContain(conversationId);

    for (const [url, method] of [
      [
        "https://123e4567-e89b-42d3-a456-426614174000.cloud.eliza.app.attacker.example/api/conversations/private/messages/stream",
        "POST",
      ],
      ["http://api.eliza.app/api/v1/eliza/personal", "GET"],
      ["https://api.eliza.app:8443/api/v1/eliza/personal", "GET"],
      ["https://user@api.eliza.app/api/v1/eliza/personal", "GET"],
      ["https://api.eliza.app/api/v1/eliza/personal", "POST"],
      ["https://api.eliza.app/api/conversations/private/messages", "POST"],
    ] as const) {
      expect(buildAndroidCloudResponseEvidence(url, method, 200)).toBeNull();
    }
  });
});
