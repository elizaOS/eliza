import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import { expect, test } from "vitest";
import { SubmittedNavigation } from "./submitted-navigation";

test("blacklist navigation checks locally before opening, fences old replies and stops a confirmed hit", async () => {
  const requests = new Map<string, ServerResponse>();
  const server = createServer((request, response) => {
    requests.set(request.url ?? "/", response);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw Error("No server address");
  const check = async (path: string) =>
    (await fetch(`http://127.0.0.1:${address.port}${path}`)).json();
  const navigation = new SubmittedNavigation({ check, policy: "blacklist" });
  try {
    navigation.open("/first");
    expect(navigation.snapshot().permitted).toBe(false);
    await expect.poll(() => requests.has("/first")).toBe(true);
    navigation.navigate("/second");
    await expect.poll(() => requests.has("/second")).toBe(true);
    requests.get("/first")?.end(JSON.stringify({ status: "blocked" }));
    requests.get("/second")?.end(JSON.stringify({ status: "unavailable" }));
    await expect
      .poll(() => navigation.snapshot().verdict?.status)
      .toBe("unavailable");
    expect(navigation.snapshot().address).toBe("/second");
    expect(navigation.snapshot().permitted).toBe(true);
    navigation.navigate("/lookalike");
    await expect.poll(() => requests.has("/lookalike")).toBe(true);
    requests.get("/lookalike")?.end(JSON.stringify({ status: "lookalike" }));
    await expect
      .poll(() => navigation.snapshot().verdict?.status)
      .toBe("lookalike");
    expect(navigation.snapshot().permitted).toBe(true);
    navigation.navigate("/hit");
    await expect.poll(() => requests.has("/hit")).toBe(true);
    requests.get("/hit")?.end(JSON.stringify({ status: "blocked" }));
    // Navigation is also unpermitted while the request is pending. Wait for
    // the server result before testing the person's explicit bypass gesture.
    await expect
      .poll(() => navigation.snapshot().verdict?.status)
      .toBe("blocked");
    expect(navigation.snapshot().permitted).toBe(false);
    const revision = navigation.snapshot().revision;
    expect(navigation.allowOnce(revision - 1)).toBe(false);
    expect(navigation.allowOnce(revision)).toBe(true);
    navigation.close();
    expect(navigation.snapshot().permitted).toBe(false);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("the default policy still requires a clean result", async () => {
  const navigation = new SubmittedNavigation({
    check: async () => ({ status: "unavailable" }),
  });
  navigation.open("https://example.org");
  expect(navigation.snapshot().permitted).toBe(false);
  await expect
    .poll(() => navigation.snapshot().verdict?.status)
    .toBe("unavailable");
  expect(navigation.snapshot().permitted).toBe(false);
});
