/** Exercises wallet provisioning and recovery through the actual bundled login child and local database. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { StewardSidecar } from "./steward-sidecar";

it("provisions a local wallet and reopens the same authority after restarting", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eliza-login-sidecar-"));
  const sidecar = new StewardSidecar({ dataDir: directory, maxRestarts: 0 });
  let resumed: StewardSidecar | undefined;
  try {
    const first = await sidecar.start();
    expect(first.state).toBe("running");
    const credentials = sidecar.getCredentials();
    if (!credentials)
      throw new Error("Provisioning returned no wallet credentials");
    expect(credentials.walletAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(credentials.agentToken).not.toBe("");
    const restarted = await sidecar.restart();
    expect(restarted.walletAddress).toBe(credentials.walletAddress);
    await sidecar.stop();
    resumed = new StewardSidecar({ dataDir: directory, maxRestarts: 0 });
    const restored = await resumed.start();
    expect(restored.state).toBe("running");
    expect(restored.walletAddress).toBe(credentials.walletAddress);
    expect(resumed.getCredentials()?.agentId).toBe(credentials.agentId);
    const response = await fetch(
      `${resumed.getApiBase()}/agents/${credentials.agentId}`,
      {
        headers: {
          "X-Steward-Tenant": credentials.tenantId,
          "X-Steward-Key": credentials.tenantApiKey,
        },
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      data: { walletAddress: credentials.walletAddress },
    });
  } finally {
    await resumed?.stop();
    await sidecar.stop();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
