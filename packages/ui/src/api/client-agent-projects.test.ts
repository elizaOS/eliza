/**
 * Typed client coverage for project registration and the Cloud publication
 * binding exposed by project summaries. Transport is stubbed, no live agent.
 */

import { describe, expect, it, vi } from "vitest";
import "./client-agent";
import { ElizaClient } from "./client-base";
import type { ProjectSummary } from "./client-types";

describe("ElizaClient project registry", () => {
  it("posts a project registration and preserves cloudAppId in the response", async () => {
    const project: ProjectSummary = {
      id: "project-1",
      name: "Proof Project",
      localPath: "/work/proof",
      cloudAppId: "cloud-app-1",
      lastOpenedAt: "2026-07-23T12:00:00.000Z",
    };
    const client = new ElizaClient("http://agent.example:31337", "token");
    const fetch = vi.fn(async () => project);
    client.fetch = fetch as typeof client.fetch;

    const result = await client.registerProject({
      name: "Proof Project",
      localPath: "/work/proof",
      repoUrl: "https://github.com/example/proof",
      defaultBranch: "develop",
    });

    expect(fetch).toHaveBeenCalledWith("/api/projects/register", {
      method: "POST",
      body: JSON.stringify({
        name: "Proof Project",
        localPath: "/work/proof",
        repoUrl: "https://github.com/example/proof",
        defaultBranch: "develop",
      }),
      headers: { "Content-Type": "application/json" },
    });
    expect(result.cloudAppId).toBe("cloud-app-1");
  });

  it("binds and unbinds the Cloud publication through typed project methods", async () => {
    const project: ProjectSummary = {
      id: "project-1",
      name: "Proof Project",
      localPath: "/work/proof",
      packageName: "@example/proof",
      cloudAppId: "cloud-app-1",
      lastOpenedAt: "2026-07-23T12:00:00.000Z",
    };
    const client = new ElizaClient("http://agent.example:31337", "token");
    const fetch = vi.fn(async () => project);
    client.fetch = fetch as typeof client.fetch;

    await expect(
      client.bindProjectCloudApp(project.id, "cloud-app-1"),
    ).resolves.toEqual(project);
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      "/api/projects/project-1/cloud-app",
      {
        method: "POST",
        body: JSON.stringify({ cloudAppId: "cloud-app-1" }),
        headers: { "Content-Type": "application/json" },
      },
    );

    await expect(client.unbindProjectCloudApp(project.id)).resolves.toEqual(
      project,
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "/api/projects/project-1/cloud-app",
      { method: "DELETE" },
    );
  });
});
