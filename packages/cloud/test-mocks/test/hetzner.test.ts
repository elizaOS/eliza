/** Covers the hetzner cloud mock with deterministic in-process state and real HTTP handlers. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { HetznerCloudClient } from "@elizaos/cloud-shared/lib/services/containers/hetzner-cloud-api";
import { type RunningHetznerMock, startHetznerMock } from "../src/hetzner";

// Speed up tests
process.env.MOCK_HETZNER_LATENCY = "0";
process.env.MOCK_HETZNER_ACTION_MS = "0";

let mock: RunningHetznerMock;

const AUTH = {
  Authorization: "Bearer test-token",
  "Content-Type": "application/json",
};

beforeAll(async () => {
  mock = await startHetznerMock({ port: 0, actionMs: 50 });
});

afterAll(async () => {
  await mock.stop();
});

async function pollAction(id: number, deadlineMs = 5000): Promise<string> {
  const deadline = Date.now() + deadlineMs;
  let last = "unknown";
  while (Date.now() < deadline) {
    const r = await fetch(`${mock.url}/actions/${id}`, { headers: AUTH });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { action: { status: string } };
    last = body.action.status;
    if (last !== "running") return last;
    await new Promise((res) => setTimeout(res, 20));
  }
  return last;
}

describe("Hetzner mock", () => {
  test("rejects requests without Authorization", async () => {
    const r = await fetch(`${mock.url}/servers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "n",
        server_type: "cx22",
        location: "fsn1",
      }),
    });
    expect(r.status).toBe(401);
    const body = (await r.json()) as { error: { code: string } };
    expect(body.error.code).toBe("unauthorized");
  });

  test("server create → action → running → poweroff → delete lifecycle", async () => {
    // Create
    const createRes = await fetch(`${mock.url}/servers`, {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({
        name: "node-a",
        server_type: "cx22",
        location: "fsn1",
        image: "ubuntu-24.04",
      }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as {
      server: {
        id: number;
        status: string;
        public_net: { ipv4: { ip: string } | null };
      };
      action: { id: number; status: string };
    };
    expect(created.action.status).toBe("running");
    expect(created.server.public_net.ipv4?.ip).toMatch(/^\d+\.\d+\.\d+\.\d+$/);

    const serverId = created.server.id;
    expect(await pollAction(created.action.id)).toBe("success");

    // After create action completes, server should be running.
    const getRes = await fetch(`${mock.url}/servers/${serverId}`, {
      headers: AUTH,
    });
    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as { server: { status: string } };
    expect(getBody.server.status).toBe("running");

    // Poweroff
    const offRes = await fetch(
      `${mock.url}/servers/${serverId}/actions/poweroff`,
      {
        method: "POST",
        headers: AUTH,
      },
    );
    expect(offRes.status).toBe(200);
    const offBody = (await offRes.json()) as { action: { id: number } };
    expect(await pollAction(offBody.action.id)).toBe("success");
    const offGet = (await (
      await fetch(`${mock.url}/servers/${serverId}`, { headers: AUTH })
    ).json()) as { server: { status: string } };
    expect(offGet.server.status).toBe("off");

    // Delete
    const delRes = await fetch(`${mock.url}/servers/${serverId}`, {
      method: "DELETE",
      headers: AUTH,
    });
    expect(delRes.status).toBe(200);
    const delBody = (await delRes.json()) as { action: { id: number } };
    expect(await pollAction(delBody.action.id)).toBe("success");

    // Now should 404
    const afterDel = await fetch(`${mock.url}/servers/${serverId}`, {
      headers: AUTH,
    });
    expect(afterDel.status).toBe(404);
  });

  test("validation error on missing fields", async () => {
    const r = await fetch(`${mock.url}/servers`, {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ name: "x" }),
    });
    expect(r.status).toBe(422);
    const body = (await r.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_input");
  });

  test("volume placement rejects provider-invalid location and server combinations", async () => {
    const both = await fetch(`${mock.url}/volumes`, {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({
        name: "invalid-volume",
        size: 10,
        location: "fsn1",
        server: 42,
      }),
    });
    expect(both.status).toBe(422);

    const neither = await fetch(`${mock.url}/volumes`, {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ name: "invalid-volume", size: 10 }),
    });
    expect(neither.status).toBe(422);

    const unattachedAutomount = await fetch(`${mock.url}/volumes`, {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({
        name: "invalid-volume",
        size: 10,
        location: "fsn1",
        automount: true,
      }),
    });
    expect(unattachedAutomount.status).toBe(422);
  });

  test("real client proves create/readback/volume/delete lifecycle over HTTP", async () => {
    const client = HetznerCloudClient.withTestTransport("test-token", {
      apiBaseUrl: mock.url,
      requestTimeoutMs: 1_000,
      lifecycleTimeoutMs: 5_000,
    });

    const created = await client.createServer({
      name: "client-node",
      serverType: "cx22",
      location: "fsn1",
      image: "ubuntu-24.04",
      userData: "#cloud-config\n",
    });
    expect(created.server).toMatchObject({ status: "running" });

    const serverId = created.server.id;
    const volume = await client.createVolume({
      name: "client-volume",
      sizeGb: 10,
      location: "fsn1",
      serverId,
      automount: false,
    });
    expect(volume).toMatchObject({
      status: "available",
      server: serverId,
    });
    expect(volume.linux_device).toContain(String(volume.id));

    await client.deleteVolume(volume.id);
    expect(await client.getVolume(volume.id)).toBeNull();
    await client.deleteServer(serverId);
    expect(await client.getServer(serverId)).toBeNull();
  });
});
