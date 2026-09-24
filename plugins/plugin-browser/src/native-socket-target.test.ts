import { createServer, type Socket } from "node:net";
import { expect, it, vi } from "vitest";
import { BrowserDispatchFailure } from "./dispatch-types";
import { NativeSocketBrowserTarget } from "./native-socket-target";

it("reports expected disconnection only once until a verified profile reconnects", async () => {
  const diagnostics: Error[] = [];
  const target = new NativeSocketBrowserTarget((error) =>
    diagnostics.push(error),
  );
  const clients = new Set<Socket>();
  const server = createServer((socket) => {
    clients.add(socket);
    socket.once("close", () => clients.delete(socket));
    const hello = Buffer.from(
      JSON.stringify({
        type: "hello",
        protocol: 2,
        extensionId: "pmldpcoefklbdbgmggcejkfoinmjfeio",
        profileId: "test-profile",
        capabilities: ["list"],
      }),
    );
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32LE(hello.length);
    socket.write(Buffer.concat([prefix, hello]));
  });
  let listening = false;
  try {
    await target.start({ ELIZA_PLATFORM: "android" });
    await vi.waitFor(() => expect(diagnostics).toHaveLength(1));
    expect(diagnostics[0]).toBeInstanceOf(BrowserDispatchFailure);
    expect((diagnostics[0] as BrowserDispatchFailure).kind).toBe("UNAVAILABLE");
    await new Promise((resolve) => setTimeout(resolve, 3300));
    expect(diagnostics).toHaveLength(1);
    await new Promise<void>((resolve) =>
      server.listen("\0ai.elizaos.app.browser.native", resolve),
    );
    listening = true;
    await vi.waitFor(async () => expect(await target.available()).toBe(true), {
      timeout: 4000,
    });
    for (const client of clients) client.destroy();
    await vi.waitFor(() => expect(diagnostics).toHaveLength(2));
    expect((diagnostics[1] as BrowserDispatchFailure).kind).toBe("UNAVAILABLE");
    expect(await target.available()).toBe(false);
  } finally {
    await target.stop();
    for (const client of clients) client.destroy();
    if (listening)
      await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 15000);
