import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cloudflareRegistrarService } from "./cloudflare-registrar";

/**
 * Guard: the dev stub (ELIZA_CF_REGISTRAR_DEV_STUB=1) fabricates registrations
 * but the buy route still debits credits, so it must never run in production.
 * `config()` reads via getCloudAwareEnv(), which falls back to process.env
 * outside a Worker context — so these tests drive it through process.env.
 */
describe("cloudflareRegistrarService production stub guard", () => {
  let savedEnvironment: string | undefined;
  let savedStub: string | undefined;

  beforeEach(() => {
    savedEnvironment = process.env.ENVIRONMENT;
    savedStub = process.env.ELIZA_CF_REGISTRAR_DEV_STUB;
  });

  afterEach(() => {
    if (savedEnvironment === undefined) delete process.env.ENVIRONMENT;
    else process.env.ENVIRONMENT = savedEnvironment;
    if (savedStub === undefined) delete process.env.ELIZA_CF_REGISTRAR_DEV_STUB;
    else process.env.ELIZA_CF_REGISTRAR_DEV_STUB = savedStub;
  });

  it("refuses the stub in production before any registrar work happens", async () => {
    process.env.ENVIRONMENT = "production";
    process.env.ELIZA_CF_REGISTRAR_DEV_STUB = "1";

    await expect(cloudflareRegistrarService.checkAvailability("guard-example.com")).rejects.toThrow(
      /production deployment/i,
    );
    await expect(cloudflareRegistrarService.registerDomain("guard-example.com")).rejects.toThrow(
      /production deployment/i,
    );
  });

  it("still serves the stub outside production (dev/test)", async () => {
    process.env.ENVIRONMENT = "development";
    process.env.ELIZA_CF_REGISTRAR_DEV_STUB = "1";

    const availability = await cloudflareRegistrarService.checkAvailability("guard-example.com");
    expect(availability.available).toBe(true);

    const registration = await cloudflareRegistrarService.registerDomain("guard-example.com");
    expect(registration.registrationId).toContain("stub-reg-");
  });
});
