/**
 * Exercises the homepage readiness policy with deterministic rendered-surface
 * fixtures; no network, browser, or provider account is used by this suite.
 */
import { expect, test } from "vitest";
import {
  evaluatePublicSurface,
  resolveWhatsAppAdmission,
} from "./check-homepage-public-readiness.mjs";

const healthySurface = {
  finalUrl: "https://eliza.app/",
  server: "cloudflare",
  bodyText: "Four hours of your time back every week.",
  messageButtonCount: 1,
  copiedPhone: "+18087881821",
  copyNotice: "Phone number copied",
  telHrefs: ["tel:+18087881821"],
  whatsAppHrefs: [],
  consoleErrors: [],
};

test("accepts the Cloudflare homepage with WhatsApp disabled", () => {
  for (const whatsAppNumber of ["", "+14159611510"]) {
    const result = evaluatePublicSurface(healthySurface, {
      whatsAppEnabled: false,
      whatsAppNumber,
    });
    expect(result.ok).toBe(true);
  }
});

test("matches the deployment workflow's admission values", () => {
  for (const value of [undefined, "", "0", "false", "no", "off"]) {
    expect(resolveWhatsAppAdmission(value)).toEqual({
      enabled: false,
      valid: true,
    });
  }
  for (const value of ["1", "true", "yes", "on"]) {
    expect(resolveWhatsAppAdmission(value)).toEqual({
      enabled: true,
      valid: true,
    });
  }
  for (const value of ["maybe", " TRUE ", " off "]) {
    expect(resolveWhatsAppAdmission(value)).toEqual({
      enabled: false,
      valid: false,
    });
  }
});

test("fails closed for an invalid admission flag", () => {
  const result = evaluatePublicSurface(healthySurface, {
    whatsAppEnabled: false,
    whatsAppAdmissionValid: false,
    whatsAppNumber: "",
  });
  expect(result.ok).toBe(false);
  expect(
    result.checks.find((entry) => entry.name === "whatsapp-sender-config")
      ?.passed,
  ).toBe(false);
});

test("evaluates an explicitly selected public origin", () => {
  const result = evaluatePublicSurface(
    { ...healthySurface, finalUrl: "https://preview.eliza.app/" },
    {
      origin: "https://preview.eliza.app",
      whatsAppEnabled: false,
      whatsAppNumber: "+18087881821",
    },
  );
  expect(result.ok).toBe(true);
});

test("rejects a stale WhatsApp CTA while admission is disabled", () => {
  const result = evaluatePublicSurface(
    {
      ...healthySurface,
      whatsAppHrefs: ["https://wa.me/14159611510"],
    },
    { whatsAppEnabled: false, whatsAppNumber: "+18087881821" },
  );
  expect(result.ok).toBe(false);
  expect(
    result.checks.find((entry) => entry.name === "whatsapp-fail-closed")
      ?.passed,
  ).toBe(false);
});

test("requires the same admitted Blooio number when WhatsApp is enabled", () => {
  const admitted = evaluatePublicSurface(
    {
      ...healthySurface,
      whatsAppHrefs: ["https://wa.me/18087881821"],
    },
    { whatsAppEnabled: true, whatsAppNumber: "+18087881821" },
  );
  expect(admitted.ok).toBe(true);

  const formerNumber = evaluatePublicSurface(
    {
      ...healthySurface,
      whatsAppHrefs: ["https://wa.me/14159611510"],
    },
    { whatsAppEnabled: true, whatsAppNumber: "+14159611510" },
  );
  expect(formerNumber.ok).toBe(false);

  for (const paddedNumber of [" +18087881821", "+18087881821 "]) {
    const padded = evaluatePublicSurface(
      {
        ...healthySurface,
        whatsAppHrefs: ["https://wa.me/18087881821"],
      },
      { whatsAppEnabled: true, whatsAppNumber: paddedNumber },
    );
    expect(padded.ok).toBe(false);
  }
});

test("rejects visible phone copy and incorrect call targets", () => {
  const result = evaluatePublicSurface(
    {
      ...healthySurface,
      bodyText: "Call +1 (808) 788-1821",
      telHrefs: ["tel:+14159611510"],
    },
    { whatsAppEnabled: false, whatsAppNumber: "+18087881821" },
  );
  expect(result.ok).toBe(false);
  expect(
    result.checks.find((entry) => entry.name === "phone-not-rendered")?.passed,
  ).toBe(false);
  expect(
    result.checks.find((entry) => entry.name === "call-target")?.passed,
  ).toBe(false);
});
