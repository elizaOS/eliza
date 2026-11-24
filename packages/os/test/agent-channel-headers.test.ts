// spec/os/agentService/channel.md, "Only the device headers and client id the runtime client carries cross the channel"; spec/os/agentService/channel.md, "Story: Ask the agent only on the routes my app allows"
import { execFileSync } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";
import { orgJsonAdapterClasspath } from "./drivers/jvm-adapter.ts";
import { androidTools } from "./support/android-tools.ts";

const javaTool = (name: string) => process.env.JAVA_HOME ? `${process.env.JAVA_HOME}/bin/${name}` : name;

async function journey(): Promise<ReadonlyMap<string, unknown>> {
  const main = "ai.eliza.os.agent.NativeHeadersJourney";
  const out = execFileSync(javaTool("java"), ["-cp", await orgJsonAdapterClasspath(main), main], { encoding: "utf8", timeout: 120_000 });
  const lines = out.split("\n").filter(Boolean).map((line) => JSON.parse(line) as { step: string; value: unknown });
  return new Map(lines.map((line) => [line.step, line.value]));
}

const tools = androidTools();
const skipped = tools.kind === "missing" ? tools.reason : null;

describe.skipIf(skipped !== null)(`Only the device headers and client id the runtime client carries cross the channel${skipped === null ? "" : ` (skipped: AgentSocketClient compiles against android.jar; ${skipped})`}`, () => {
  let steps: ReadonlyMap<string, unknown>;
  beforeAll(async () => { steps = await journey(); }, 180_000);

  it("carries a native caller's device headers and client id to the agent's socket with lowercase names", () => {
    expect(steps.get("opened")).toBe(true);
    expect(steps.get("device-status")).toBe(201);
    expect(steps.get("device-method")).toBe("http_request");
    expect(steps.get("device-headers")).toEqual({
      authorization: "Bearer root-token-for-the-journey",
      "content-type": "application/json",
      "x-elizaos-client-id": "phone-client-1",
      "x-eliza-device-id": "device-1",
      "x-eliza-device-capabilities": "sms,call",
      "x-eliza-device-key": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    });
  });

  it("carries them on a native stream as well", () => {
    expect(steps.get("stream-outcome")).toBe("END");
    expect(steps.get("stream-method")).toBe("http_request_stream");
    expect(steps.get("stream-headers")).toEqual({
      authorization: "Bearer root-token-for-the-journey",
      "content-type": "application/json",
      "x-elizaos-client-id": "phone-client-1",
    });
  });

  it("keeps a native call that names no headers to the service's own", () => {
    expect(steps.get("plain-status")).toBe(201);
    expect(steps.get("plain-headers")).toEqual({ authorization: "Bearer root-token-for-the-journey", "content-type": "application/json" });
    expect(steps.get("null-headers-status")).toBe(201);
    expect(steps.get("null-headers")).toEqual({ authorization: "Bearer root-token-for-the-journey", "content-type": "application/json" });
  });

  it("refuses a native call naming a header the client would not carry before any I/O", () => {
    expect(steps.get("credential-status")).toBe("ROUTE_REFUSED");
    expect(steps.get("authorization-status")).toBe("ROUTE_REFUSED");
    expect(steps.get("short-key-status")).toBe("ROUTE_REFUSED");
    expect(steps.get("unprintable-status")).toBe("ROUTE_REFUSED");
    expect(steps.get("too-many-status")).toBe("TOO_LARGE");
    expect(steps.get("refused-stream-outcome")).toBe("ROUTE_REFUSED");
    expect(steps.get("refused-frames-sent")).toBe(0);
  });
});
