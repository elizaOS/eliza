/**
 * Upload receipt extraction tests drive a real @slack/web-api WebClient
 * against a local mock of the three-step files.uploadV2 wire flow
 * (getUploadURLExternal → external POST → completeUploadExternal) and assert
 * the provider receipt SlackService.uploadFile surfaces, including the
 * explicit failure when the completion response carries no file data.
 */
import http from "node:http";
import { WebClient } from "@slack/web-api";
import { afterEach, describe, expect, it } from "vitest";
import { extractUploadReceipt } from "./service";

const servers: http.Server[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.close();
  }
});

function startMockSlackApi(
  completeResponse: string,
): Promise<{ apiUrl: string; requests: string[] }> {
  const requests: string[] = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let _body = "";
      req.on("data", (chunk) => {
        _body += chunk;
      });
      req.on("end", () => {
        requests.push(`${req.url}`);
        if (req.url?.includes("/files.getUploadURLExternal")) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              ok: true,
              upload_url: `http://${req.headers.host}/external-upload`,
              file_id: "F06A5F9PQ0Z",
            }),
          );
        } else if (req.url === "/external-upload") {
          res.writeHead(200);
          res.end("OK");
        } else if (req.url?.includes("/files.completeUploadExternal")) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(completeResponse);
        } else {
          res.writeHead(404);
          res.end("{}");
        }
      });
    });
    servers.push(server);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" ? address?.port : 0;
      resolve({ apiUrl: `http://127.0.0.1:${port}/api/`, requests });
    });
  });
}

async function runUploadV2(apiUrl: string): Promise<unknown> {
  const client = new WebClient("xoxb-test-token", { slackApiUrl: apiUrl });
  return client.files.uploadV2({
    channel_id: "C0614G0B5LY",
    filename: "cat.png",
    content: "fake-png-bytes",
  });
}

describe("extractUploadReceipt / files.uploadV2 wire shape", () => {
  it("surfaces the real file id and permalink from result.files[0]", async () => {
    const { apiUrl } = await startMockSlackApi(
      JSON.stringify({
        ok: true,
        files: [
          {
            id: "F06A5F9PQ0Z",
            created: 1756000000,
            timestamp: 1756000000,
            name: "cat.png",
            permalink: "https://example.slack.com/files/F06A5F9PQ0Z/cat.png",
          },
        ],
      }),
    );

    const result = await runUploadV2(apiUrl);

    expect(extractUploadReceipt(result)).toEqual({
      fileId: "F06A5F9PQ0Z",
      permalink: "https://example.slack.com/files/F06A5F9PQ0Z/cat.png",
    });
  });

  it("fails explicitly when the completion response carries no file data", async () => {
    const { apiUrl } = await startMockSlackApi(JSON.stringify({ ok: true }));

    const result = await runUploadV2(apiUrl);

    expect(() => extractUploadReceipt(result)).toThrow(
      "Slack files.uploadV2 response contained no file data",
    );
  });
});
