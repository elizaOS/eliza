import { expect, test } from "bun:test";
import { protectedGithubEvidence } from "./pitr-github-evidence";

test("GitHub token stays on GitHub; signed log download gets no auth and bounded reads", async () => {
  const calls: Array<{ url: string; headers: unknown }> = [];
  const client = protectedGithubEvidence({
    token: "private sentinel",
    signal: new AbortController().signal,
    fetch: async (url, init) => {
      calls.push({ url: String(url), headers: init?.headers });
      return calls.length === 1
        ? new Response(null, {
            status: 302,
            headers: {
              location:
                "https://synthetic.blob.core.windows.net/log?signature=synthetic",
            },
          })
        : new Response("finite log");
    },
  });
  expect(await client.text("repos/elizaOS/eliza/actions/jobs/1/logs")).toBe(
    "finite log",
  );
  expect(calls[1].headers).toBeUndefined();
  expect(calls[0].url).toBe(
    "https://api.github.com/repos/elizaOS/eliza/actions/jobs/1/logs",
  );
});
test("unapproved redirects, unrelated routes and oversized logs refuse with fixed errors", async () => {
  for (const kind of ["redirect", "route", "size"]) {
    let calls = 0;
    const client = protectedGithubEvidence({
      token: "private sentinel",
      signal: new AbortController().signal,
      fetch: async () => {
        calls++;
        return kind === "redirect"
          ? new Response(null, {
              status: 302,
              headers: { location: "https://untrusted.example/private" },
            })
          : new Response("x".repeat(8 * 1024 * 1024 + 1));
      },
    });
    await expect(
      client.text(
        kind === "route"
          ? "repos/other/repo/actions/jobs/1/logs"
          : "repos/elizaOS/eliza/actions/jobs/1/logs",
      ),
    ).rejects.toThrow("backup_github_evidence_unavailable");
    expect(calls).toBe(kind === "route" ? 0 : 1);
  }
});
