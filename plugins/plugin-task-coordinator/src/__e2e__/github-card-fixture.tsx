/**
 * Mounts the real guided GitHub card against a query-selected in-page API.
 * The screenshot harness supplies host UI/client primitives, so every state
 * can be reviewed without booting the complete application server.
 */

import { createRoot } from "react-dom/client";
import { GitHubConnectionCard } from "../GitHubConnectionCard";

type Responder = (path: string, init?: RequestInit) => unknown;

declare global {
  interface Window {
    __ghFetch: (path: string, init?: RequestInit) => Promise<unknown>;
  }
}

function scriptedBackend(state: string): Responder {
  let statusRequests = 0;
  const disconnected = { connected: false, deviceFlowAvailable: true };
  const connected = {
    connected: true,
    deviceFlowAvailable: true,
    username: "eliza-agent-bot",
    scopes: ["repo", "read:user"],
    savedAt: 1_720_000_000_000,
  };
  const started = {
    status: "started",
    flowId: "fixture-flow",
    userCode: "ELIZ-A123",
    verificationUri: "https://github.com/login/device",
    intervalSeconds: 1,
    expiresInSeconds: 900,
  };
  return (path, init) => {
    const method = init?.method ?? "GET";
    if (path === "/api/github/token" && method === "GET") {
      statusRequests += 1;
      if (state === "loading") return new Promise(() => undefined);
      if (
        state === "unavailable" ||
        (state === "retry" && statusRequests === 1)
      ) {
        throw new Error("Encrypted credential vault is unavailable");
      }
      if (state === "pat-only")
        return { connected: false, deviceFlowAvailable: false };
      if (state === "connected") return connected;
      return disconnected;
    }
    if (path === "/api/github/device/start") return started;
    if (path === "/api/github/device/reconnect") {
      return { ...started, mode: "reconnect" };
    }
    if (path === "/api/github/device/poll") {
      if (state === "denied") return { status: "denied" };
      if (state === "expired") return { status: "expired" };
      if (state === "success") return { status: "complete", ...connected };
      return { status: "pending", retryAfterSeconds: 5 };
    }
    if (path === "/api/github/device/cancel") {
      return { status: "cancelled" };
    }
    if (path === "/api/github/token" && method === "POST") return connected;
    throw new Error(`fixture: unexpected request ${method} ${path}`);
  };
}

const params = new URLSearchParams(window.location.search);
const state = params.get("state") ?? "device";
const respond = scriptedBackend(state);
window.__ghFetch = async (path, init) => respond(path, init);

const root = createRoot(document.getElementById("root") as HTMLElement);
root.render(
  <div
    data-testid="github-card-fixture"
    className="min-h-screen bg-bg p-6 text-txt"
  >
    <div className="mx-auto w-full max-w-md rounded-lg border border-border bg-card p-3">
      <GitHubConnectionCard />
    </div>
  </div>,
);
