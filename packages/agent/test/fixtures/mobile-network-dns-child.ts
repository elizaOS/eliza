import assert from "node:assert/strict";
import dns from "node:dns";
import http from "node:http";
import {
  configureMobileDnsIfNeeded,
  mobileDnsServers,
} from "../../src/runtime/mobile-dns.ts";

assert.deepEqual(mobileDnsServers("10.0.2.3, 2001:db8::53,10.0.2.3"), [
  "10.0.2.3",
  "2001:db8::53",
]);
for (const value of [
  "",
  "resolver.example",
  "https://1.1.1.1",
  "127.0.0.1:53",
  "1.1.1.1,",
  Array(9).fill("1.1.1.1").join(","),
])
  assert.throws(() => mobileDnsServers(value), /Invalid native/);
configureMobileDnsIfNeeded();
assert.deepEqual(dns.getServers(), ["10.0.2.3", "2001:db8::53"]);
const server = http.createServer((_request, response) =>
  response.end("local gateway remains reachable"),
);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
try {
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const response = await fetch(`http://127.0.0.1:${address.port}`);
  assert.equal(await response.text(), "local gateway remains reachable");
  configureMobileDnsIfNeeded();
  assert.deepEqual(dns.getServers(), ["10.0.2.3", "2001:db8::53"]);
  console.log("native DNS configuration and loopback transport passed");
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
