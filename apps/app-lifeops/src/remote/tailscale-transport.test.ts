import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetProcessRunnerForTests,
  __setProcessRunnerForTests,
  getTailscaleStatus,
  releasePort,
  reserveServerPort,
  selectRemoteTransport,
  type ProcessResult,
  type ProcessRunner,
} from "./tailscale-transport";

interface RecordedCall {
  command: string;
  args: ReadonlyArray<string>;
  detached: boolean;
}

class FakeRunner implements ProcessRunner {
  public readonly calls: RecordedCall[] = [];
  private script: Array<(call: RecordedCall) => Promise<ProcessResult> | ProcessResult>;

  constructor(
    script: Array<(call: RecordedCall) => Promise<ProcessResult> | ProcessResult>,
  ) {
    this.script = script;
  }

  async run(
    command: string,
    args: ReadonlyArray<string>,
    options: { detached?: boolean } = {},
  ): Promise<ProcessResult> {
    const call: RecordedCall = {
      command,
      args,
      detached: options.detached === true,
    };
    this.calls.push(call);
    const next = this.script.shift();
    if (!next) {
      throw new Error(`Unexpected extra CLI call: ${command} ${args.join(" ")}`);
    }
    return await next(call);
  }
}

class EnoentRunner implements ProcessRunner {
  public calls = 0;
  run(): Promise<ProcessResult> {
    this.calls += 1;
    const err = new Error("spawn tailscale ENOENT") as Error & {
      code: string;
    };
    err.code = "ENOENT";
    return Promise.reject(err);
  }
}

const STATUS_RUNNING = {
  BackendState: "Running",
  CurrentTailnet: {
    Name: "example.ts.net",
    MagicDNSSuffix: "example.ts.net",
  },
  Self: {
    HostName: "my-mac",
    DNSName: "my-mac.example.ts.net.",
    TailscaleIPs: ["100.64.0.1"],
  },
};

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  __resetProcessRunnerForTests();
});

describe("getTailscaleStatus", () => {
  it("returns available:true with node + magicDNS when tailscale is running", async () => {
    const runner = new FakeRunner([
      () => ({
        exitCode: 0,
        stdout: JSON.stringify(STATUS_RUNNING),
        stderr: "",
      }),
    ]);
    __setProcessRunnerForTests(runner);

    const status = await getTailscaleStatus();

    expect(status).toEqual({
      available: true,
      nodeName: "my-mac",
      magicDNSName: "my-mac.example.ts.net",
      tailnet: "example.ts.net",
    });
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0].args).toEqual(["status", "--json"]);
  });

  it("returns available:false with install reason when CLI is missing (ENOENT)", async () => {
    __setProcessRunnerForTests(new EnoentRunner());
    const status = await getTailscaleStatus();
    expect(status.available).toBe(false);
    expect(status.reason).toBe("tailscale-cli-not-installed");
  });

  it("returns available:false when backend is not Running", async () => {
    const runner = new FakeRunner([
      () => ({
        exitCode: 0,
        stdout: JSON.stringify({
          BackendState: "Stopped",
          CurrentTailnet: null,
        }),
        stderr: "",
      }),
    ]);
    __setProcessRunnerForTests(runner);
    const status = await getTailscaleStatus();
    expect(status.available).toBe(false);
    expect(status.reason).toBe("tailscale-backend-Stopped");
  });

  it("returns available:false when status CLI fails", async () => {
    const runner = new FakeRunner([
      () => ({
        exitCode: 1,
        stdout: "",
        stderr: "not logged in",
      }),
    ]);
    __setProcessRunnerForTests(runner);
    const status = await getTailscaleStatus();
    expect(status.available).toBe(false);
    expect(status.reason).toBe("tailscale-status-failed");
  });

  it("falls back to HostName + MagicDNSSuffix when DNSName is absent", async () => {
    const runner = new FakeRunner([
      () => ({
        exitCode: 0,
        stdout: JSON.stringify({
          BackendState: "Running",
          CurrentTailnet: {
            Name: "t.ts.net",
            MagicDNSSuffix: "t.ts.net",
          },
          Self: { HostName: "laptop", TailscaleIPs: ["100.64.0.2"] },
        }),
        stderr: "",
      }),
    ]);
    __setProcessRunnerForTests(runner);
    const status = await getTailscaleStatus();
    expect(status.magicDNSName).toBe("laptop.t.ts.net");
  });
});

describe("reserveServerPort / releasePort", () => {
  it("reserves foreground with `tailscale serve https:/ https://localhost:<port>`", async () => {
    const runner = new FakeRunner([
      () => ({
        exitCode: 0,
        stdout: JSON.stringify(STATUS_RUNNING),
        stderr: "",
      }),
      () => ({ exitCode: 0, stdout: "", stderr: "" }),
    ]);
    __setProcessRunnerForTests(runner);

    const reserved = await reserveServerPort(31_337);

    expect(reserved.magicDNSUrl).toBe("https://my-mac.example.ts.net");
    expect(runner.calls[1].args).toEqual([
      "serve",
      "https:/",
      "https://localhost:31337",
    ]);
    expect(runner.calls[1].detached).toBe(false);
  });

  it("reserves background with --bg and detaches", async () => {
    const runner = new FakeRunner([
      () => ({
        exitCode: 0,
        stdout: JSON.stringify(STATUS_RUNNING),
        stderr: "",
      }),
      () => ({ exitCode: 0, stdout: "", stderr: "" }),
    ]);
    __setProcessRunnerForTests(runner);

    await reserveServerPort(4443, { background: true });

    expect(runner.calls[1].args).toEqual([
      "serve",
      "--bg",
      "https:/",
      "https://localhost:4443",
    ]);
    expect(runner.calls[1].detached).toBe(true);
  });

  it("throws when tailscale is unavailable (fallback chain: caller should fall through)", async () => {
    __setProcessRunnerForTests(new EnoentRunner());
    await expect(reserveServerPort(8080)).rejects.toThrow(
      /tailscale-cli-not-installed/,
    );
  });

  it("throws on invalid port", async () => {
    await expect(reserveServerPort(0)).rejects.toThrow(/Invalid port/);
    await expect(reserveServerPort(70_000)).rejects.toThrow(/Invalid port/);
  });

  it("releasePort swallows non-zero exit codes (idempotent)", async () => {
    const runner = new FakeRunner([
      () => ({ exitCode: 1, stdout: "", stderr: "already off" }),
    ]);
    __setProcessRunnerForTests(runner);
    await expect(releasePort(31_337)).resolves.toBeUndefined();
  });

  it("releasePort throws when CLI is missing", async () => {
    __setProcessRunnerForTests(new EnoentRunner());
    await expect(releasePort(31_337)).rejects.toThrow(
      /tailscale CLI not installed/,
    );
  });
});

describe("selectRemoteTransport", () => {
  it("returns the env value when it is a valid transport", () => {
    expect(selectRemoteTransport("tailscale")).toBe("tailscale");
    expect(selectRemoteTransport("cloud")).toBe("cloud");
    expect(selectRemoteTransport("local")).toBe("local");
  });

  it("defaults to local for unset or invalid env", () => {
    expect(selectRemoteTransport(undefined)).toBe("local");
    expect(selectRemoteTransport("")).toBe("local");
    expect(selectRemoteTransport("vpn")).toBe("local");
  });
});

describe("fallback chain integration", () => {
  it("selectRemoteTransport=tailscale + getTailscaleStatus unavailable means caller must fall through", async () => {
    __setProcessRunnerForTests(new EnoentRunner());
    const transport = selectRemoteTransport("tailscale");
    const status = await getTailscaleStatus();
    // This is the exact check RemoteSessionService.startSession() performs.
    const shouldUseTailscale = transport === "tailscale" && status.available;
    expect(shouldUseTailscale).toBe(false);
  });

  it("selectRemoteTransport=tailscale + getTailscaleStatus available means caller uses tailscale", async () => {
    const runner = new FakeRunner([
      () => ({
        exitCode: 0,
        stdout: JSON.stringify(STATUS_RUNNING),
        stderr: "",
      }),
    ]);
    __setProcessRunnerForTests(runner);
    const transport = selectRemoteTransport("tailscale");
    const status = await getTailscaleStatus();
    expect(transport === "tailscale" && status.available).toBe(true);
  });
});
