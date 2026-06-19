// View-bundle `interact` capability handler, split out of FeedOperatorSurface.tsx
// so that file exports only React components and stays Fast-Refresh-compatible
// (Vite would full-reload a component file that also exports a plain function).
// The view bundle re-exports `interact` via ./feed-view-bundle.ts.

async function readFeedJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      text || `[feed] ${response.status} ${response.statusText}`.trim(),
    );
  }
  return text ? JSON.parse(text) : {};
}

export async function interact(
  capability: string,
  params?: Record<string, unknown>,
): Promise<unknown> {
  if (capability === "get-state" || capability === "refresh-agent-status") {
    const [status, dashboard, markets] = await Promise.all([
      fetch("/api/apps/feed/agent/status", {
        headers: { Accept: "application/json" },
      }).then(readFeedJson),
      fetch("/api/apps/feed/team/dashboard", {
        headers: { Accept: "application/json" },
      }).then(readFeedJson),
      fetch("/api/apps/feed/markets?pageSize=5", {
        headers: { Accept: "application/json" },
      }).then(readFeedJson),
    ]);
    return { status, dashboard, markets };
  }

  if (capability === "open-live-dashboard") {
    return {
      path: "/feed",
      endpoints: [
        "/api/apps/feed/agent/status",
        "/api/apps/feed/team/dashboard",
        "/api/apps/feed/markets",
      ],
    };
  }

  if (capability === "send-team-message") {
    const content =
      typeof params?.content === "string" && params.content.trim()
        ? params.content.trim()
        : "Terminal status check";
    const response = await fetch("/api/apps/feed/team/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
    return readFeedJson(response);
  }

  throw new Error(`Feed TUI does not support "${capability}".`);
}
