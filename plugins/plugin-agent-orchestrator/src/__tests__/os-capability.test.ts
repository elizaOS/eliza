import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { osCapabilityAction } from "../actions/os-capability";

const originalRunner = process.env.ELIZAOS_CAPABILITY_RUNNER;
afterEach(() => {
  if (originalRunner === undefined)
    delete process.env.ELIZAOS_CAPABILITY_RUNNER;
  else process.env.ELIZAOS_CAPABILITY_RUNNER = originalRunner;
});

describe("elizaOS capability action", () => {
  it("is hidden when no executable broker is configured", async () => {
    delete process.env.ELIZAOS_CAPABILITY_RUNNER;
    expect(
      await osCapabilityAction.validate?.(
        {} as never,
        {} as never,
        {} as never,
      ),
    ).toBe(false);
  });

  it("passes a closed operation and argv without shell interpolation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "elizaos-broker-"));
    const runner = join(dir, "runner");
    await writeFile(runner, "#!/bin/sh\nprintf '%s\\n' \"$@\"\n");
    await chmod(runner, 0o755);
    process.env.ELIZAOS_CAPABILITY_RUNNER = runner;

    const result = await osCapabilityAction.handler?.(
      { logger: { error: () => undefined } } as never,
      { content: {} } as never,
      undefined,
      {
        parameters: { operation: "service", args: ["restart", "eliza agent"] },
      } as never,
    );
    expect(result?.success).toBe(true);
    expect(result?.text).toBe("service\nrestart\neliza agent");
  });

  it("requires the owner role and rejects arbitrary execution", async () => {
    expect(osCapabilityAction.roleGate).toEqual({ minRole: "OWNER" });

    const result = await osCapabilityAction.handler?.(
      { logger: { error: () => undefined } } as never,
      { content: {} } as never,
      undefined,
      { parameters: { operation: "exec", args: ["--", "/bin/sh"] } } as never,
    );
    expect(result).toEqual({
      success: false,
      text: "Invalid elizaOS operation.",
    });
  });
});
