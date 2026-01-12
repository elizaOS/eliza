import { beforeEach, describe, expect, it } from "vitest";
import { GITHUB_SERVICE_NAME, GitHubService } from "../service";

describe("GitHubService", () => {
  let service: GitHubService;

  beforeEach(() => {
    service = new GitHubService();
  });

  it("should have correct service name", () => {
    expect(GitHubService.serviceType).toBe("github");
  });

  it("should be creatable", () => {
    expect(service).toBeInstanceOf(GitHubService);
  });

  it("should have correct name property", () => {
    expect(service.name).toBe(GITHUB_SERVICE_NAME);
  });
});
