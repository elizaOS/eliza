import { afterEach, expect, it } from "bun:test";
import net from "node:net";
import { probeBionicNetworkPolicy } from "../src/bionic-network-policy.js";

const servers: net.Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
});
async function host(responses: unknown[]) {
  const name = `eliza-network-proof-${process.pid}-${crypto.randomUUID()}`;
  let count = 0;
  const server = net.createServer((socket) => {
    let input = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      input = Buffer.concat([input, chunk]);
      if (input.length < 4 || input.length < 4 + input.readUInt32BE()) return;
      const request = JSON.parse(input.subarray(4).toString());
      expect(request).toEqual({ op: "networkPolicy" });
      const response = Buffer.from(JSON.stringify(responses[count++]));
      const frame = Buffer.alloc(4 + response.length);
      frame.writeUInt32BE(response.length);
      response.copy(frame, 4);
      socket.end(frame);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(`\0${name}`, resolve);
  });
  return name;
}
it("reads each transition rather than caching an unmetered result", async () => {
  const states = [
    { connectionType: "wifi", metered: false },
    { connectionType: "wifi", metered: true },
    { connectionType: "none", metered: null },
  ];
  const name = await host(
    states.map((state) => ({
      ok: true,
      state: { ...state, source: "android-os" },
    })),
  );
  for (const state of states)
    expect(await probeBionicNetworkPolicy(name)).toEqual(state);
});
it("rejects unavailable and malformed host responses", async () => {
  for (const response of [
    null,
    { ok: false },
    {
      ok: true,
      state: { connectionType: ["wifi"], metered: false, source: "android-os" },
    },
    {
      ok: true,
      state: { connectionType: "wifi", metered: "false", source: "android-os" },
    },
  ]) {
    const name = await host([response]);
    await expect(probeBionicNetworkPolicy(name)).rejects.toThrow();
  }
});
it("rejects a missing host instead of returning unmetered", async () => {
  await expect(
    probeBionicNetworkPolicy(`eliza-missing-${crypto.randomUUID()}`),
  ).rejects.toThrow();
});
