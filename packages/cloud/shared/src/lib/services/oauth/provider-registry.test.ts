/**
 * Exercises provider-registry lookup, scope, and credential diagnostics with
 * deterministic cloud-binding contexts and no external OAuth traffic.
 */
import { describe, expect, test } from "vitest";
import { runWithCloudBindings } from "../../runtime/cloud-bindings";
import {
  getAllowedScopes,
  getAllProviderIds,
  getCallbackUrl,
  getNestedValue,
  getProvider,
  getProviderEnvDiagnostics,
  isProviderConfigured,
  isValidProvider,
  type OAuthProviderConfig,
  projectOAuthConnectedAccount,
  resolveOAuthCapabilityRequest,
  resolveRequestedScopes,
} from "./provider-registry";

const provider = (o: Partial<OAuthProviderConfig>): OAuthProviderConfig =>
  ({
    id: "test",
    type: "oauth2",
    envVars: [],
    useGenericRoutes: true,
    allowedScopes: ["read", "write"],
    defaultScopes: ["read"],
    ...o,
  }) as OAuthProviderConfig;

describe("provider lookup", () => {
  test("getProvider is case-insensitive; isValidProvider matches the registry", () => {
    const id = getAllProviderIds()[0];
    expect(getAllProviderIds().length).toBeGreaterThan(0);
    expect(getProvider(id.toUpperCase())?.id).toBeDefined();
    expect(getProvider("definitely-not-a-provider")).toBeNull();
    expect(isValidProvider(id)).toBe(true);
    expect(isValidProvider("definitely-not-a-provider")).toBe(false);
  });
});

describe("getAllowedScopes / resolveRequestedScopes", () => {
  test("allowed scopes fall back default → allowed, normalized + deduped", () => {
    expect(getAllowedScopes(provider({}))).toEqual(["read", "write"]);
    expect(
      getAllowedScopes(provider({ allowedScopes: undefined, defaultScopes: ["x", "x"] })),
    ).toEqual(["x"]);
  });

  test("empty request → default scopes; valid request passes; invalid THROWS", () => {
    const p = provider({});
    expect(resolveRequestedScopes(p, [])).toEqual(["read"]); // default
    expect(resolveRequestedScopes(p, ["read", " write "])).toEqual(["read", "write"]);
    // 'admin' is not in the allowlist → scope-escalation attempt must throw.
    expect(() => resolveRequestedScopes(p, ["read", "admin"])).toThrow();
  });
});

describe("incremental capability scope bundles (#19879)", () => {
  test("the seven promoted providers use minimal baselines while retaining legacy scope allowlists", () => {
    const expectedBaselines: Record<string, string[]> = {
      google: [
        "https://www.googleapis.com/auth/userinfo.email",
        "https://www.googleapis.com/auth/userinfo.profile",
      ],
      microsoft: ["openid", "profile", "email", "offline_access", "User.Read"],
      github: ["read:user", "user:email"],
      linear: ["read"],
      slack: ["users:read"],
      salesforce: ["id", "refresh_token"],
      airtable: ["user.email:read"],
    };

    for (const [providerId, baseline] of Object.entries(expectedBaselines)) {
      const registered = getProvider(providerId);
      expect(registered?.defaultScopes).toEqual(baseline);
      expect(registered?.capabilityScopes).toBeDefined();
      expect(registered?.allowedScopes?.length).toBeGreaterThan(baseline.length);
      for (const scope of baseline) {
        expect(registered?.allowedScopes).toContain(scope);
      }
    }
  });

  test("derives only baseline plus the requested named capability", () => {
    const google = getProvider("google");
    if (!google) throw new Error("google provider must exist");

    const request = resolveOAuthCapabilityRequest(google, ["calendar.events.read"]);

    expect(request.scopes).toEqual([
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/userinfo.profile",
      "https://www.googleapis.com/auth/calendar.readonly",
    ]);
    expect(request.scopes).not.toContain("https://www.googleapis.com/auth/gmail.send");
    expect(request.capabilities).toEqual([
      {
        capabilityId: "calendar.events.read",
        riskLevel: "R1",
        status: "needs_scope",
        missingScopes: ["https://www.googleapis.com/auth/calendar.readonly"],
        missingUserScopes: [],
      },
    ]);
  });

  test("projects available, review, and admin states from actual grants", () => {
    const google = getProvider("google");
    const salesforce = getProvider("salesforce");
    if (!google || !salesforce) throw new Error("promoted providers must exist");

    expect(
      resolveOAuthCapabilityRequest(
        google,
        ["calendar.events.read"],
        ["https://www.googleapis.com/auth/calendar.readonly"],
      ).capabilities[0]?.status,
    ).toBe("available");
    expect(
      resolveOAuthCapabilityRequest(google, ["email.messages.send"]).capabilities[0]?.status,
    ).toBe("needs_review");
    expect(
      resolveOAuthCapabilityRequest(salesforce, ["crm.full_control"]).capabilities[0]?.status,
    ).toBe("needs_admin");
  });

  test("preserves an existing allowed grant while adding one capability", () => {
    const google = getProvider("google");
    if (!google) throw new Error("google provider must exist");

    const request = resolveOAuthCapabilityRequest(
      google,
      ["calendar.events.read"],
      ["https://www.googleapis.com/auth/gmail.readonly"],
    );

    expect(request.scopes).toEqual([
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/userinfo.profile",
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/calendar.readonly",
    ]);
    expect(request.capabilities[0]?.status).toBe("needs_scope");
  });

  test("splits Slack bot and user scopes without restoring the old broad default", () => {
    const slack = getProvider("slack");
    if (!slack) throw new Error("slack provider must exist");

    const request = resolveOAuthCapabilityRequest(slack, ["messages.send", "files.read"]);

    expect(request.scopes).toEqual(["users:read"]);
    expect(request.userScopes).toEqual(["identity.basic", "chat:write", "files:read"]);

    const agentRequest = resolveOAuthCapabilityRequest(
      slack,
      ["messages.send", "files.read"],
      [],
      [],
      "AGENT",
    );
    expect(agentRequest.scopes).toEqual(["users:read", "chat:write", "files:read"]);
    expect(agentRequest.userScopes).toEqual(["identity.basic"]);
  });

  test("deduplicates repeated capabilities and fails closed for unknown names", () => {
    const airtable = getProvider("airtable");
    if (!airtable) throw new Error("airtable provider must exist");

    const request = resolveOAuthCapabilityRequest(airtable, ["records.read", "records.read"]);
    expect(request.capabilities).toHaveLength(1);
    expect(request.scopes).toEqual(["user.email:read", "data.records:read"]);
    expect(() => resolveOAuthCapabilityRequest(airtable, ["not-real"])).toThrow(
      "Requested capabilities are not registered",
    );
  });

  test("uses one provider-neutral vocabulary for equivalent Google and Microsoft grants", () => {
    const google = getProvider("google");
    const microsoft = getProvider("microsoft");
    if (!google || !microsoft) throw new Error("calendar providers must exist");

    for (const capabilityId of ["calendar.events.read", "calendar.events.write"]) {
      expect(google.capabilityScopes?.[capabilityId]).toBeDefined();
      expect(microsoft.capabilityScopes?.[capabilityId]).toBeDefined();
    }
    expect(getProvider("github")?.capabilityScopes?.["repositories.full_control"]).toMatchObject({
      scopes: ["repo"],
      riskLevel: "R3",
    });
  });

  test("projects an opaque canonical account and invalidates capabilities with lifecycle state", () => {
    const google = getProvider("google");
    if (!google) throw new Error("google provider must exist");
    const baseConnection = {
      id: "11111111-1111-4111-8111-111111111111",
      userId: "cloud-user-private",
      connectionRole: "owner" as const,
      platform: "google",
      platformUserId: "provider-user-private",
      email: "private@example.test",
      displayName: "Work calendar",
      status: "active" as const,
      scopes: ["https://www.googleapis.com/auth/calendar.events"],
      linkedAt: new Date("2026-08-19T00:00:00.000Z"),
      tokenExpired: false,
      source: "platform_credentials" as const,
    };

    const connected = projectOAuthConnectedAccount(google, baseConnection);
    expect(JSON.stringify(connected)).not.toMatch(/provider-user-private|private@example/);
    expect(connected).toMatchObject({
      contractVersion: 2,
      accountId: baseConnection.id,
      providerId: "google",
      mode: "cloud",
      status: "connected",
    });
    expect(
      connected.capabilities.find(({ capabilityId }) => capabilityId === "calendar.events.write"),
    ).toMatchObject({ riskLevel: "R2", status: "available" });

    const revoked = projectOAuthConnectedAccount(google, {
      ...baseConnection,
      status: "revoked",
    });
    expect(revoked.status).toBe("revoked");
    expect(revoked.capabilities.every(({ status }) => status === "account_revoked")).toBe(true);
  });

  test("validates every registered bundle against its provider allowlists", () => {
    for (const providerId of [
      "google",
      "microsoft",
      "github",
      "linear",
      "slack",
      "salesforce",
      "airtable",
    ]) {
      const registered = getProvider(providerId);
      if (!registered?.capabilityScopes) {
        throw new Error(`${providerId} capability registry must exist`);
      }
      expect(() =>
        resolveOAuthCapabilityRequest(registered, Object.keys(registered.capabilityScopes)),
      ).not.toThrow();
    }
  });
});

describe("getCallbackUrl / getNestedValue", () => {
  test("generic callback URL is built from the base + provider id", () => {
    expect(getCallbackUrl(provider({ id: "x" }), "https://h.io")).toBe(
      "https://h.io/api/v1/oauth/x/callback",
    );
  });

  test("getNestedValue walks dot paths and is null-safe", () => {
    const obj = { data: { viewer: { id: "abc" } } };
    expect(getNestedValue(obj, "data.viewer.id")).toBe("abc");
    expect(getNestedValue(obj, "data.missing.id")).toBeUndefined();
    expect(getNestedValue(null, "a.b")).toBeUndefined();
  });
});

describe("getProviderEnvDiagnostics", () => {
  test("returns one entry per provider with configured + missingEnvVars fields", () => {
    const diagnostics = getProviderEnvDiagnostics();
    const providerIds = getAllProviderIds();

    expect(diagnostics).toHaveLength(providerIds.length);

    for (const entry of diagnostics) {
      expect(entry.id).toBeDefined();
      expect(entry.name).toBeDefined();
      expect(entry.type).toBeDefined();
      expect(typeof entry.configured).toBe("boolean");
      expect(Array.isArray(entry.missingEnvVars)).toBe(true);
      expect(typeof entry.requiredForDeployment).toBe("boolean");

      if (entry.configured) {
        expect(entry.missingEnvVars).toEqual([]);
      } else {
        expect(entry.missingEnvVars.length).toBeGreaterThan(0);
      }
    }
  });

  test("entries map 1:1 to the registry by id", () => {
    const diagnostics = getProviderEnvDiagnostics();
    const providerIds = new Set(getAllProviderIds());
    const diagnosticIds = new Set(diagnostics.map((d) => d.id));
    expect(diagnosticIds).toEqual(providerIds);
  });

  test("Twitter reports the satisfied alternative instead of contradictory missing vars", () => {
    const twitter = getProvider("twitter") as OAuthProviderConfig;
    const result = runWithCloudBindings(
      {
        TWITTER_API_KEY: "",
        TWITTER_API_SECRET_KEY: "",
        TWITTER_CLIENT_ID: "client-id",
      },
      () => ({
        configured: isProviderConfigured(twitter),
        diagnostic: getProviderEnvDiagnostics().find((d) => d.id === "twitter"),
      }),
    );

    expect(result.configured).toBe(true);
    expect(result.diagnostic).toMatchObject({
      configured: true,
      missingEnvVars: [],
    });
  });

  test("reports the shortest actionable alternative when no Twitter path is complete", () => {
    const diagnostic = runWithCloudBindings(
      {
        TWITTER_API_KEY: "",
        TWITTER_API_SECRET_KEY: "",
        TWITTER_CLIENT_ID: "",
      },
      () => getProviderEnvDiagnostics().find((d) => d.id === "twitter"),
    );

    expect(diagnostic).toMatchObject({
      configured: false,
      missingEnvVars: ["TWITTER_CLIENT_ID"],
    });
  });

  test("respects runWithCloudBindings context for env-var detection", () => {
    const inside = runWithCloudBindings(
      { GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret" },
      () => getProviderEnvDiagnostics().find((d) => d.id === "google"),
    );

    expect(inside).toBeDefined();
    expect(inside?.missingEnvVars).toEqual([]);
    expect(inside?.configured).toBe(true);
    expect(inside?.requiredForDeployment).toBe(true);
  });

  test("rejects whitespace-only required Google credentials", () => {
    const google = getProvider("google") as OAuthProviderConfig;
    const diagnostic = runWithCloudBindings(
      { GOOGLE_CLIENT_ID: "  ", GOOGLE_CLIENT_SECRET: "\t" },
      () => getProviderEnvDiagnostics().find((d) => d.id === "google"),
    );
    const configured = runWithCloudBindings(
      { GOOGLE_CLIENT_ID: "  ", GOOGLE_CLIENT_SECRET: "\t" },
      () => isProviderConfigured(google),
    );

    expect(configured).toBe(false);
    expect(diagnostic).toMatchObject({
      configured: false,
      requiredForDeployment: true,
      missingEnvVars: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
    });
  });
});
