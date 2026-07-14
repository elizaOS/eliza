/**
 * Locks the /api/health package-smoke nonce echo. The packaged-runtime
 * verifier (packages/scripts/verify-packaged-cli.mjs) injects
 * ELIZA_PACKAGE_SMOKE_NONCE into the spawned service and requires the health
 * payload to echo it, so an unrelated healthy server already bound to the
 * probe port can never satisfy an installed-package smoke.
 */
import { afterEach, describe, expect, it } from "vitest";
import { handleHealthRoutes } from "./health-routes";

type HealthPayload = Record<string, unknown> & {
  verificationNonce?: string;
};

async function healthResponse(): Promise<HealthPayload> {
  let payload: HealthPayload | undefined;
  const handled = await handleHealthRoutes({
    res: {},
    method: "GET",
    pathname: "/api/health",
    url: new URL("http://127.0.0.1/api/health"),
    state: {
      runtime: null,
      startedAt: Date.now(),
      plugins: [],
      agentState: "running",
      startup: { phase: "ready" },
      config: {},
      connectorHealthMonitor: undefined,
    },
    json: (_res: unknown, body: unknown) => {
      payload = body as HealthPayload;
    },
    error: () => {
      throw new Error("health route must not error in this scenario");
    },
  } as unknown as Parameters<typeof handleHealthRoutes>[0]);
  expect(handled).toBe(true);
  if (!payload) throw new Error("health route did not write a JSON payload");
  return payload;
}

const previousNonce = process.env.ELIZA_PACKAGE_SMOKE_NONCE;

afterEach(() => {
  if (previousNonce === undefined) {
    delete process.env.ELIZA_PACKAGE_SMOKE_NONCE;
  } else {
    process.env.ELIZA_PACKAGE_SMOKE_NONCE = previousNonce;
  }
});

describe("GET /api/health package-smoke nonce", () => {
  it("omits verificationNonce outside package verification", async () => {
    delete process.env.ELIZA_PACKAGE_SMOKE_NONCE;
    const payload = await healthResponse();
    expect(payload.verificationNonce).toBeUndefined();
    expect("verificationNonce" in payload).toBe(false);
  });

  it("echoes the injected nonce so the verifier can prove process identity", async () => {
    process.env.ELIZA_PACKAGE_SMOKE_NONCE = "package-proof-nonce";
    const payload = await healthResponse();
    expect(payload.verificationNonce).toBe("package-proof-nonce");
  });
});
