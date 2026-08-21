/**
 * Covers the native personal-data capability projection: deterministic mapping
 * of every permission status (granted/limited/denied/not-determined/both
 * restricted reasons/not-applicable) into capability statuses, foreground and
 * background gating, offline invariance, fail-fast on missing or duplicate
 * states, and the metadata-only key-closure guard. Pure functions, no mocks.
 */
import { describe, expect, it } from "vitest";
import {
  assertNativePersonalDataProjectionMetadataOnly,
  NATIVE_PERSONAL_DATA_DOMAIN_DEFINITIONS,
  NATIVE_PERSONAL_DATA_DOMAINS,
  type NativePersonalDataProjection,
  type NativePersonalDataRuntimeContext,
  projectNativePersonalDataCapabilities,
} from "./native-personal-data.js";
import type {
  PermissionId,
  PermissionState,
  PermissionStatus,
} from "./permissions.js";

const GENERATED_AT = "2026-08-20T00:00:00.000Z";

function state(
  id: PermissionId,
  status: PermissionStatus = "granted",
  overrides: Partial<PermissionState> = {},
): PermissionState {
  return {
    id,
    status,
    lastChecked: 1000,
    canRequest: status === "not-determined",
    platform: "ios",
    ...overrides,
  };
}

function allGranted(): PermissionState[] {
  return NATIVE_PERSONAL_DATA_DOMAINS.map((d) => state(d));
}

function foreground(
  overrides: Partial<NativePersonalDataRuntimeContext> = {},
): NativePersonalDataRuntimeContext {
  return {
    platform: "ios",
    online: true,
    appState: "foreground",
    ...overrides,
  };
}

function project(
  states: PermissionState[],
  runtime = foreground(),
): NativePersonalDataProjection {
  return projectNativePersonalDataCapabilities(states, runtime, GENERATED_AT);
}

function domainStatus(p: NativePersonalDataProjection, domain: string) {
  const found = p.domains.find((d) => d.domain === domain);
  if (!found) throw new Error(`missing domain ${domain}`);
  return found;
}

describe("projectNativePersonalDataCapabilities", () => {
  it("projects all eight domains as available when every permission is granted", () => {
    const p = project(allGranted());
    expect(p.domains).toHaveLength(8);
    expect(p.residency).toBe("device");
    expect(p.account.mode).toBe("native");
    expect(p.account.status).toBe("connected");
    expect(p.account.accountId).toBe("native-device:ios");
    for (const d of p.domains) {
      expect(d.availability).toBe("available");
      expect(d.worksOffline).toBe(true);
      expect(d.residency).toBe("device");
      for (const c of d.capabilities) expect(c.status).toBe("available");
    }
    const ids = p.account.capabilities.map((c) => c.capabilityId);
    expect(ids).toContain("native.contacts.read");
    expect(ids).toContain("native.messages.dispatch");
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("is deterministic for identical inputs", () => {
    const a = project(allGranted());
    const b = project(allGranted());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("maps denied to needs_scope and limited to available with limited domain availability", () => {
    const states = allGranted().map((s) =>
      s.id === "contacts"
        ? state("contacts", "denied")
        : s.id === "photos"
          ? state("photos", "limited")
          : s,
    );
    const p = project(states);
    const contacts = domainStatus(p, "contacts");
    expect(contacts.availability).toBe("denied");
    for (const c of contacts.capabilities) expect(c.status).toBe("needs_scope");
    const photos = domainStatus(p, "photos");
    expect(photos.availability).toBe("limited");
    expect(photos.capabilities[0].status).toBe("available");
  });

  it("maps not-determined to needs_permission / not_configured", () => {
    const states = allGranted().map((s) =>
      s.id === "health" ? state("health", "not-determined") : s,
    );
    const health = domainStatus(project(states), "health");
    expect(health.availability).toBe("needs_permission");
    expect(health.canRequest).toBe(true);
    expect(health.capabilities[0].status).toBe("not_configured");
  });

  it("distinguishes restricted reasons: platform_unsupported vs os_policy", () => {
    const states = allGranted().map((s) => {
      if (s.id === "messages")
        return state("messages", "restricted", {
          restrictedReason: "platform_unsupported",
        });
      if (s.id === "location")
        return state("location", "restricted", {
          restrictedReason: "os_policy",
        });
      return s;
    });
    const p = project(states);
    const messages = domainStatus(p, "messages");
    expect(messages.availability).toBe("restricted");
    expect(messages.restrictedReason).toBe("platform_unsupported");
    for (const c of messages.capabilities) expect(c.status).toBe("unsupported");
    const location = domainStatus(p, "location");
    expect(location.capabilities[0].status).toBe("needs_admin");
  });

  it("maps not-applicable to unsupported", () => {
    const states = allGranted().map((s) =>
      s.id === "phone" ? state("phone", "not-applicable") : s,
    );
    const phone = domainStatus(project(states), "phone");
    expect(phone.availability).toBe("unsupported");
    for (const c of phone.capabilities) expect(c.status).toBe("unsupported");
  });

  it("reports the account unavailable when no domain is usable", () => {
    const states = NATIVE_PERSONAL_DATA_DOMAINS.map((d) => state(d, "denied"));
    const p = project(states);
    expect(p.account.status).toBe("unavailable");
  });

  it("gates foreground-only capabilities when the app is backgrounded", () => {
    const p = project(allGranted(), foreground({ appState: "background" }));
    const photosRead = domainStatus(p, "photos").capabilities.find(
      (c) => c.capabilityId === "native.photos.read",
    );
    expect(photosRead?.status).toBe("provider_unavailable");
    const phoneDispatch = domainStatus(p, "phone").capabilities.find(
      (c) => c.capabilityId === "native.phone.dispatch",
    );
    expect(phoneDispatch?.status).toBe("provider_unavailable");
    const contactsRead = domainStatus(p, "contacts").capabilities.find(
      (c) => c.capabilityId === "native.contacts.read",
    );
    expect(contactsRead?.status).toBe("available");
  });

  it("does not degrade availability offline (data lives on device)", () => {
    const online = project(allGranted(), foreground({ online: true }));
    const offline = project(allGranted(), foreground({ online: false }));
    expect(offline.runtime.online).toBe(false);
    expect(JSON.stringify(offline.domains)).toBe(
      JSON.stringify(online.domains),
    );
  });

  it("throws on a missing domain permission state instead of fabricating one", () => {
    const states = allGranted().filter((s) => s.id !== "reminders");
    expect(() => project(states)).toThrowError(/reminders/);
  });

  it("throws on duplicate states for one domain", () => {
    const states = [...allGranted(), state("contacts", "denied")];
    expect(() => project(states)).toThrowError(/duplicate/);
  });

  it("ignores unrelated permission ids", () => {
    const states = [...allGranted(), state("microphone"), state("shell")];
    expect(project(states).domains).toHaveLength(8);
  });

  it("escalates risk with side-effect scope in the domain table", () => {
    const defs = NATIVE_PERSONAL_DATA_DOMAIN_DEFINITIONS;
    expect(defs.health.operations[0].riskLevel).toBe("R2");
    expect(
      defs.phone.operations.find((o) => o.operation === "dispatch")?.riskLevel,
    ).toBe("R3");
    expect(
      defs.messages.operations.find((o) => o.operation === "dispatch")
        ?.riskLevel,
    ).toBe("R3");
  });
});

describe("assertNativePersonalDataProjectionMetadataOnly", () => {
  it("accepts a projection produced by the projector", () => {
    const p = project(allGranted());
    expect(() =>
      assertNativePersonalDataProjectionMetadataOnly(p),
    ).not.toThrow();
  });

  it("rejects a projection smuggling a personal-data payload field", () => {
    const p = project(allGranted()) as NativePersonalDataProjection & {
      domains: Array<Record<string, unknown>>;
    };
    p.domains[0] = { ...p.domains[0], contacts: [{ displayName: "Alice" }] };
    expect(() =>
      assertNativePersonalDataProjectionMetadataOnly(p),
    ).toThrowError(/metadata-only/);
  });
});
