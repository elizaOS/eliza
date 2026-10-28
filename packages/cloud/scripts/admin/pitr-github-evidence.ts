/** Bounded private GitHub reads. Tokens and signed log URLs never enter diagnostics. */
export function protectedGithubEvidence(input: {
  token: string;
  signal: AbortSignal;
  fetch?: (url: string | URL, init: RequestInit) => Promise<Response>;
}) {
  const request = input.fetch ?? fetch;
  const read = async (path: string, logs: boolean): Promise<string> => {
    try {
      if (
        !input.token ||
        !/^repos\/elizaOS\/eliza\/(?:git\/ref\/heads\/main|actions\/(?:runs\/[1-9][0-9]*(?:\/jobs\?per_page=100)?|jobs\/[1-9][0-9]*\/logs))$/.test(
          path,
        )
      )
        throw Error();
      if (logs !== path.endsWith("/logs")) throw Error();
      const signal = AbortSignal.any([
        input.signal,
        AbortSignal.timeout(120000),
      ]);
      let response = await request(`https://api.github.com/${path}`, {
        headers: {
          Authorization: `Bearer ${input.token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        redirect: "manual",
        signal,
      });
      if (logs && response.status === 302) {
        const location = response.headers.get("location");
        if (!location) throw Error();
        const url = new URL(location);
        if (
          url.protocol !== "https:" ||
          url.username ||
          url.password ||
          url.port ||
          !url.hostname.endsWith(".blob.core.windows.net")
        )
          throw Error();
        await response.body?.cancel();
        // Signed storage URL receives no GitHub Authorization header.
        response = await request(url, { redirect: "error", signal });
      }
      if (!response.ok || !response.body) throw Error();
      const chunks: Uint8Array[] = [];
      let length = 0;
      const reader = response.body.getReader();
      try {
        for (;;) {
          const value = await reader.read();
          if (value.done) break;
          length += value.value.byteLength;
          if (length > 8 * 1024 * 1024) throw Error();
          chunks.push(value.value);
        }
      } finally {
        await reader.cancel();
      }
      return Buffer.concat(chunks).toString("utf8");
    } catch {
      throw Error("backup_github_evidence_unavailable");
    }
  };
  return {
    json: async (path: string) => {
      try {
        return JSON.parse(await read(path, false)) as unknown;
      } catch {
        throw Error("backup_github_evidence_unavailable");
      }
    },
    text: (path: string) => read(path, true),
  };
}
