/**
 * Tests for strict SMTP_PORT parsing and initialization boundary validation in EmailService.
 *
 * Drives production seam: imports resolveSmtpPort and SmtpPortConfigError from
 * email.ts and exercises EmailService initialization and send path with a mocked transporter.
 * Reverting production validation (e.g., fallback to 587) makes this suite red.
 */

import nodemailer from "nodemailer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EmailService, resolveSmtpPort, SmtpPortConfigError } from "./email";

const originalEnv = {
  SMTP_HOST: process.env.SMTP_HOST,
  SMTP_PORT: process.env.SMTP_PORT,
  SMTP_PASSWORD: process.env.SMTP_PASSWORD,
  SMTP_USERNAME: process.env.SMTP_USERNAME,
  SENDGRID_API_KEY: process.env.SENDGRID_API_KEY,
};

function restoreEnv(): void {
  if (originalEnv.SMTP_HOST === undefined) delete process.env.SMTP_HOST;
  else process.env.SMTP_HOST = originalEnv.SMTP_HOST;
  if (originalEnv.SMTP_PORT === undefined) delete process.env.SMTP_PORT;
  else process.env.SMTP_PORT = originalEnv.SMTP_PORT;
  if (originalEnv.SMTP_PASSWORD === undefined) delete process.env.SMTP_PASSWORD;
  else process.env.SMTP_PASSWORD = originalEnv.SMTP_PASSWORD;
  if (originalEnv.SMTP_USERNAME === undefined) delete process.env.SMTP_USERNAME;
  else process.env.SMTP_USERNAME = originalEnv.SMTP_USERNAME;
  if (originalEnv.SENDGRID_API_KEY === undefined) delete process.env.SENDGRID_API_KEY;
  else process.env.SENDGRID_API_KEY = originalEnv.SENDGRID_API_KEY;
}

describe("resolveSmtpPort strict parsing", () => {
  it("parses valid canonical ports and trims surrounding whitespace", () => {
    expect(resolveSmtpPort("587")).toBe(587);
    expect(resolveSmtpPort("465")).toBe(465);
    expect(resolveSmtpPort("25")).toBe(25);
    expect(resolveSmtpPort("2525")).toBe(2525);
    expect(resolveSmtpPort(" 2525 ")).toBe(2525);
    expect(resolveSmtpPort("\t587\n")).toBe(587);
    expect(resolveSmtpPort("1")).toBe(1);
    expect(resolveSmtpPort("65535")).toBe(65535);
  });

  it("rejects trailing junk (parseInt would accept)", () => {
    for (const bad of ["587abc", "25junk", "587\nabc", "465xyz", "90abc", "25px"]) {
      expect(() => resolveSmtpPort(bad)).toThrow(SmtpPortConfigError);
    }
  });

  it("rejects decimal and exponent forms", () => {
    for (const bad of ["587.5", "587.0", "1e3", "1E3", "5e-324", "0x10", "1.0", "0xFF"]) {
      expect(() => resolveSmtpPort(bad)).toThrow(SmtpPortConfigError);
    }
  });

  it("rejects signed and leading-zero variants", () => {
    for (const bad of ["-25", "+25", "-1", "+587", "007", "0587", "00", "0123", "0001"]) {
      expect(() => resolveSmtpPort(bad)).toThrow(SmtpPortConfigError);
    }
  });

  it("rejects whitespace-only, empty, null, and undefined inputs", () => {
    for (const bad of ["", "   ", "\t", "\n", " \t\n ", null, undefined as unknown as string]) {
      expect(() => resolveSmtpPort(bad)).toThrow(SmtpPortConfigError);
    }
  });

  it("rejects out-of-range and non-canonical bounds", () => {
    expect(() => resolveSmtpPort("0")).toThrow(SmtpPortConfigError);
    expect(() => resolveSmtpPort("65536")).toThrow(SmtpPortConfigError);
    expect(() => resolveSmtpPort("70000")).toThrow(SmtpPortConfigError);
    expect(() => resolveSmtpPort("99999")).toThrow(SmtpPortConfigError);
    expect(() => resolveSmtpPort("1000000")).toThrow(SmtpPortConfigError);
  });

  it("is mutation-sensitive: reverting to parseInt fallback would not throw for trailing junk", () => {
    expect(() => resolveSmtpPort("587abc")).toThrow(SmtpPortConfigError);
    expect(() => resolveSmtpPort("1e3")).toThrow(SmtpPortConfigError);
    expect(() => resolveSmtpPort("007")).toThrow(SmtpPortConfigError);
    expect(() => resolveSmtpPort("  ")).toThrow(SmtpPortConfigError);
    expect(() => resolveSmtpPort("65536")).toThrow(SmtpPortConfigError);
  });
});

describe("EmailService SMTP_PORT integration drives production resolver", () => {
  beforeEach(() => {
    restoreEnv();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    restoreEnv();
    vi.restoreAllMocks();
  });

  it("initializes SMTP with a valid strict port and sends via mocked transporter", async () => {
    process.env.SMTP_HOST = "smtp.example.com";
    process.env.SMTP_PORT = " 587 ";
    process.env.SMTP_PASSWORD = "secret";
    process.env.SMTP_USERNAME = "user@example.com";

    const sendMailMock = vi.fn().mockResolvedValue({ messageId: "msg-123" });
    const createSpy = vi
      .spyOn(nodemailer, "createTransport")
      .mockReturnValue({ sendMail: sendMailMock } as unknown as ReturnType<
        typeof nodemailer.createTransport
      >);

    const svc = new EmailService();
    const result = await svc.send({
      to: "recipient@example.com",
      subject: "Test Subject",
      text: "Test body content",
    });

    expect(result).toBe(true);
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({ port: 587, host: "smtp.example.com" }),
    );
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    expect(sendMailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "recipient@example.com",
        subject: "Test Subject",
        text: "Test body content",
      }),
    );
  });

  it("throws SmtpPortConfigError at init boundary for trailing junk (does not fallback to 587)", () => {
    process.env.SMTP_HOST = "smtp.example.com";
    process.env.SMTP_PORT = "587abc";
    process.env.SMTP_PASSWORD = "secret";

    const createSpy = vi.spyOn(nodemailer, "createTransport");
    const svc = new EmailService();
    expect(() => (svc as unknown as { initialize: () => void }).initialize()).toThrow(
      SmtpPortConfigError,
    );
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("throws SmtpPortConfigError at init boundary when SMTP_PORT is empty string", () => {
    process.env.SMTP_HOST = "smtp.example.com";
    process.env.SMTP_PORT = "";
    process.env.SMTP_PASSWORD = "secret";

    const createSpy = vi.spyOn(nodemailer, "createTransport");
    const svc = new EmailService();
    expect(() => (svc as unknown as { initialize: () => void }).initialize()).toThrow(
      SmtpPortConfigError,
    );
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("throws SmtpPortConfigError and does not bypass to SendGrid when SMTP_PORT is empty string", () => {
    process.env.SMTP_HOST = "smtp.example.com";
    process.env.SMTP_PORT = "";
    process.env.SMTP_PASSWORD = "secret";
    process.env.SENDGRID_API_KEY = "SG.test-api-key";

    const svc = new EmailService();
    expect(() => (svc as unknown as { initialize: () => void }).initialize()).toThrow(
      SmtpPortConfigError,
    );
  });

  it("throws for decimal, exponent, signed, and leading-zero forms via EmailService", () => {
    const cases = ["587.5", "1e3", "-25", "+25", "007", "0587"];
    for (const badPort of cases) {
      process.env.SMTP_HOST = "smtp.example.com";
      process.env.SMTP_PORT = badPort;
      process.env.SMTP_PASSWORD = "secret";
      const svc = new EmailService();
      expect(() => (svc as unknown as { initialize: () => void }).initialize()).toThrow(
        SmtpPortConfigError,
      );
    }
  });

  it("throws for whitespace-only and out-of-range via EmailService (no silent 587)", () => {
    for (const badPort of ["   ", "0", "65536", "70000"]) {
      process.env.SMTP_HOST = "smtp.example.com";
      process.env.SMTP_PORT = badPort;
      process.env.SMTP_PASSWORD = "secret";
      const svc = new EmailService();
      expect(() => (svc as unknown as { initialize: () => void }).initialize()).toThrow(
        SmtpPortConfigError,
      );
    }
  });

  it("throws typed SmtpPortConfigError (not generic Error) so callers can branch", () => {
    process.env.SMTP_HOST = "smtp.example.com";
    process.env.SMTP_PORT = "not-a-port";
    process.env.SMTP_PASSWORD = "secret";
    const svc = new EmailService();
    try {
      (svc as unknown as { initialize: () => void }).initialize();
      throw new Error("expected to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(SmtpPortConfigError);
      expect((error as Error).name).toBe("SmtpPortConfigError");
    }
  });
});
