import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SIGNAL_CLI_PATH,
  DEFAULT_SIGNAL_HTTP_HOST,
  DEFAULT_SIGNAL_HTTP_PORT,
  defaultSignalAuthDir,
} from "../src/service";

describe("signal plugin defaults", () => {
  it("defaults cli binary name to `signal-cli`", () => {
    expect(DEFAULT_SIGNAL_CLI_PATH).toBe("signal-cli");
  });

  it("defaults http host to loopback", () => {
    expect(DEFAULT_SIGNAL_HTTP_HOST).toBe("127.0.0.1");
  });

  it("defaults http port to 8080 (signal-cli REST default)", () => {
    expect(DEFAULT_SIGNAL_HTTP_PORT).toBe(8080);
  });

  it("defaults auth dir to $HOME/.local/share/signal-cli on every platform", () => {
    // signal-cli hardcodes this XDG path; do NOT use macOS Library/.
    expect(defaultSignalAuthDir()).toBe(path.join(os.homedir(), ".local", "share", "signal-cli"));
  });

  it("auth dir default is stable across calls (pure function)", () => {
    expect(defaultSignalAuthDir()).toBe(defaultSignalAuthDir());
  });
});
