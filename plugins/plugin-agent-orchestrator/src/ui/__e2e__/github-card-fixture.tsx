/**
 * Render-only fixture for the GitHub connection card (#15796). Mounts the real
 * `GitHubConnectionCard` with a scripted `/api/github/*` backend (selected via
 * the `?state=` query param) so the esbuild + playwright harness can
 * screenshot the actual component in each guided-setup state — no app server.
 * The `@elizaos/ui` module is stubbed by the runner's esbuild resolver with
 * brand-faithful Button/Input primitives and a `client.fetch` that delegates
 * to `window.__ghFetch` (defined here).
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
      if (state === "pat-only")
        return { connected: false, deviceFlowAvailable: false };
      if (state === "connected") return connected;
      return disconnected;
    }
    if (path === "/api/github/device/start") return started;
    if (path === "/api/github/device/poll") {
      if (state === "denied") return { status: "denied" };
      return { status: "pending", retryAfterSeconds: 5 };
    }
    if (path === "/api/github/token" && method === "POST") return connected;
    throw new Error(`fixture: unexpected request ${method} ${path}`);
  };
}

const params = new URLSearchParams(window.location.search);
const state = params.get("state") ?? "device";
const respond = scriptedBackend(state);
window.__ghFetch = (path, init) => Promise.resolve(respond(path, init));

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
