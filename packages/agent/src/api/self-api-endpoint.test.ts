import { afterEach, expect, it } from "vitest";
import {
  hasSelfApiTcpListener,
  resolveSelfApiTcpBaseUrl,
  setSelfApiTcpListenerBound,
} from "./self-api-endpoint";

afterEach(() => setSelfApiTcpListenerBound(undefined));

it("reports no listener for local-agent IPC without an exposed port", () => {
  const env = { ELIZA_LOCAL_AGENT_TRANSPORT: "filesystem-v1" };
  expect(hasSelfApiTcpListener(env)).toBe(false);
  expect(resolveSelfApiTcpBaseUrl(env)).toBeNull();
});

it("resolves the listener URL when the IPC host exported a port", () => {
  const env = {
    ELIZA_LOCAL_AGENT_TRANSPORT: "filesystem-v1",
    ELIZA_API_PORT: "31337",
  };
  expect(hasSelfApiTcpListener(env)).toBe(true);
  expect(resolveSelfApiTcpBaseUrl(env)).toBe("http://127.0.0.1:31337");
});

it("resolves the default URL without a local transport", () => {
  expect(resolveSelfApiTcpBaseUrl({ ELIZA_PORT: "2140" })).toBe(
    "http://127.0.0.1:2140",
  );
});

it("prefers the listener state the API server published", () => {
  setSelfApiTcpListenerBound(false);
  expect(resolveSelfApiTcpBaseUrl({ ELIZA_PORT: "2140" })).toBeNull();
  setSelfApiTcpListenerBound(true);
  expect(
    hasSelfApiTcpListener({ ELIZA_LOCAL_AGENT_TRANSPORT: "filesystem-v1" }),
  ).toBe(true);
});
