import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./api-base-owner", () => ({
  setCurrent: vi.fn(),
  pushToWindow: vi.fn(),
}));

import { publishAgentApiBase } from "./agent-ready-publish";
import * as apiBaseOwner from "./api-base-owner";

describe("publishAgentApiBase", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sets the source-of-truth API base even with no open windows", () => {
    publishAgentApiBase("http://127.0.0.1:31337", "tok", []);

    expect(apiBaseOwner.setCurrent).toHaveBeenCalledWith(
      "http://127.0.0.1:31337",
      "tok",
    );
    expect(apiBaseOwner.pushToWindow).not.toHaveBeenCalled();
  });

  it("sets the base before pushing to every provided window", () => {
    const a = { webview: { rpc: {} } };
    const b = { webview: { rpc: {} } };

    publishAgentApiBase("http://127.0.0.1:42", "t", [a, b]);

    expect(apiBaseOwner.setCurrent).toHaveBeenCalledWith(
      "http://127.0.0.1:42",
      "t",
    );
    expect(apiBaseOwner.pushToWindow).toHaveBeenCalledTimes(2);
    expect(apiBaseOwner.pushToWindow).toHaveBeenNthCalledWith(1, a);
    expect(apiBaseOwner.pushToWindow).toHaveBeenNthCalledWith(2, b);
  });

  it("defaults targets to empty so a headless caller may omit windows", () => {
    publishAgentApiBase("http://127.0.0.1:9", "");

    expect(apiBaseOwner.setCurrent).toHaveBeenCalledWith(
      "http://127.0.0.1:9",
      "",
    );
    expect(apiBaseOwner.pushToWindow).not.toHaveBeenCalled();
  });
});
