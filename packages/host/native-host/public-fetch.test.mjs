import assert from "node:assert/strict";
import { createServer } from "node:net";
import test from "node:test";
import {
  privateAddress,
  publicFetch,
  resolvesPublic,
  vettedLookup,
} from "./public-fetch.mjs";

test("private, loopback, documentation and transition addresses are never public", () => {
  for (const address of [
    "127.0.0.1",
    "10.1.2.3",
    "172.20.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "192.0.2.10",
    "198.51.100.7",
    "203.0.113.9",
    "198.18.0.1",
    "224.0.0.1",
    "0.0.0.0",
    "::",
    "::1",
    "fe80::1",
    "fd00::1",
    "::ffff:127.0.0.1",
    "64:ff9b::a9fe:a9fe",
    "64:ff9b:1::1",
    "2001:db8::1",
    "2001:0:4136:e378::1",
    "2002:7f00:1::",
    "ff02::1",
    "not an ip",
  ])
    assert.ok(privateAddress(address), address);
  for (const address of [
    "93.184.216.34",
    "1.1.1.1",
    "2606:4700::1111",
    "2002:5db8:d822::",
  ])
    assert.ok(!privateAddress(address), address);
});

test("a name is public only when it resolves and every address is public", async () => {
  assert.equal(
    await resolvesPublic("broken.example", async () => {
      throw new Error("NXDOMAIN");
    }),
    false,
  );
  assert.equal(
    await resolvesPublic("mixed.example", async () => [
      { address: "93.184.216.34" },
      { address: "10.0.0.1" },
    ]),
    false,
  );
  assert.equal(
    await resolvesPublic("site.example", async () => ["93.184.216.34"]),
    true,
  );
  assert.equal(await resolvesPublic("[::1]"), false);
});

test("the connect-time lookup answers in both of Node's shapes, with public addresses only", async () => {
  const lookup = vettedLookup(async () => [
    { address: "93.184.216.34", family: 4 },
    { address: "2606:2800:220:1::", family: 6 },
  ]);
  const one = await new Promise((resolve, reject) =>
    lookup("site.example", { family: 6 }, (error, address, family) =>
      error ? reject(error) : resolve({ address, family }),
    ),
  );
  assert.deepEqual(one, { address: "2606:2800:220:1::", family: 6 });
  const all = await new Promise((resolve, reject) =>
    lookup("site.example", { all: true }, (error, list) =>
      error ? reject(error) : resolve(list),
    ),
  );
  assert.equal(all.length, 2);
  const mixed = vettedLookup(async () => [
    { address: "93.184.216.34", family: 4 },
    { address: "10.0.0.1", family: 4 },
  ]);
  await assert.rejects(
    new Promise((resolve, reject) =>
      mixed("site.example", { all: true }, (error) =>
        error ? reject(error) : resolve(),
      ),
    ),
    { code: "EPRIVATE" },
  );
});

test("the fetch checks the address it connects to, so DNS rebinding cannot reach a local service", async (t) => {
  let connections = 0;
  const local = createServer((socket) => {
    connections++;
    socket.destroy();
  });
  await new Promise((resolve) => local.listen(0, "127.0.0.1", resolve));
  t.after(() => local.close());
  const { port } = local.address();
  await assert.rejects(
    publicFetch(
      `https://lan.example:${port}/`,
      {},
      { resolve: async () => [{ address: "192.168.1.20", family: 4 }] },
    ),
    { code: "EPRIVATE" },
  );
  await assert.rejects(
    publicFetch(
      `https://rebind.example:${port}/`,
      {},
      { resolve: async () => [{ address: "127.0.0.1", family: 4 }] },
    ),
    { code: "EPRIVATE" },
  );
  await assert.rejects(publicFetch(`https://127.0.0.1:${port}/`), {
    code: "EPRIVATE",
  });
  await assert.rejects(publicFetch(`http://example.com:${port}/`), TypeError);
  await assert.rejects(
    publicFetch(`https://user:pass@example.com:${port}/`),
    TypeError,
  );
  await assert.rejects(publicFetch("not a url"), TypeError);
  assert.equal(connections, 0, "nothing reached the local service");
});
