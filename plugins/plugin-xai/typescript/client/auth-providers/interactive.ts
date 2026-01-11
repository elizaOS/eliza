import { createServer } from "node:http";
import * as readline from "node:readline";
import { URL } from "node:url";
import { logger } from "@elizaos/core";

export interface OAuthCallbackResult {
  code: string;
  state?: string;
}

function canPrompt(): boolean {
  return !!process.stdin && !!process.stdout && process.stdin.isTTY === true;
}

export async function promptForRedirectedUrl(promptText: string): Promise<string> {
  if (!canPrompt()) {
    throw new Error(
      "X OAuth requires interactive setup, but stdin is not a TTY. " +
        "Re-run with an interactive terminal or use a runtime with persistent settings storage."
    );
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const question = (q: string) => new Promise<string>((resolve) => rl.question(q, resolve));

  try {
    const answer = await question(promptText);
    return answer.trim();
  } finally {
    rl.close();
  }
}

export async function waitForLoopbackCallback(
  redirectUri: string,
  expectedState: string,
  timeoutMs = 5 * 60 * 1000
): Promise<OAuthCallbackResult> {
  const url = new URL(redirectUri);
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
    throw new Error(
      `Redirect URI must be loopback (127.0.0.1/localhost) to use local callback server; got ${url.hostname}`
    );
  }

  // Avoid privileged ports by default. If the user doesn't specify a port, use 8080.
  const port = Number(url.port || "8080");
  const path = url.pathname || "/";

  return await new Promise<OAuthCallbackResult>((resolve, reject) => {
    let settled = false;

    const finish = (err?: Error, value?: OAuthCallbackResult) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else if (value) resolve(value);
      else reject(new Error("OAuth callback finished without result"));
      try {
        server.close();
      } catch {
        // ignore
      }
    };

    const server = createServer((req, res) => {
      try {
        const reqUrl = new URL(req.url ?? "", `http://${url.hostname}:${port}`);
        if (reqUrl.pathname !== path) {
          res.writeHead(404);
          res.end("Not Found");
          return;
        }

        const code = reqUrl.searchParams.get("code");
        const state = reqUrl.searchParams.get("state") ?? undefined;
        const error = reqUrl.searchParams.get("error");
        const errorDesc = reqUrl.searchParams.get("error_description");

        if (error) {
          res.writeHead(400, { "content-type": "text/plain" });
          res.end(`OAuth error: ${error}${errorDesc ? ` - ${errorDesc}` : ""}`);
          finish(new Error(`OAuth error: ${error}${errorDesc ? ` - ${errorDesc}` : ""}`));
          return;
        }

        if (!code) {
          res.writeHead(400, { "content-type": "text/plain" });
          res.end("Missing code");
          finish(new Error("Missing code"));
          return;
        }

        if (state && state !== expectedState) {
          res.writeHead(400, { "content-type": "text/plain" });
          res.end("State mismatch");
          finish(new Error("OAuth state mismatch"));
          return;
        }

        res.writeHead(200, { "content-type": "text/plain" });
        res.end("X auth completed. You can close this tab.");
        finish(undefined, { code, state });
      } catch (e) {
        finish(e instanceof Error ? e : new Error(String(e)));
      }
    });

    const timer = setTimeout(() => {
      finish(new Error("Timed out waiting for X OAuth callback"));
    }, timeoutMs);

    server.on("close", () => clearTimeout(timer));
    server.once("error", (err: unknown) => {
      // EADDRINUSE / EACCES / etc. should fail fast instead of hanging until timeout.
      const errorObj = err as { code?: string; message?: string };
      const code = errorObj?.code ? ` (${errorObj.code})` : "";
      finish(new Error(`OAuth callback server error${code}: ${errorObj?.message ?? String(err)}`));
    });
    server.listen(port, url.hostname, () => {
      logger.info(`X OAuth callback server listening on http://${url.hostname}:${port}${path}`);
    });
  });
}
