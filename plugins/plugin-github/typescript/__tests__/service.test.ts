import { beforeEach, describe, expect, it } from "vitest";
import { GitHubService } from "../src/service";

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

  it("should not be started initially", () => {
    expect(service.isRunning).toBe(false);
  });
});
