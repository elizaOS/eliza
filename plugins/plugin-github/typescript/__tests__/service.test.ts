import { describe, expect, it } from "vitest";
import { GITHUB_SERVICE_NAME, GitHubService } from "../service";

describe("GitHubService", () => {
  // =========================================================================
  // Static properties
  // =========================================================================
  describe("static properties", () => {
    it("should have 'github' as serviceType", () => {
      expect(GitHubService.serviceType).toBe("github");
    });

    it("should have serviceType matching GITHUB_SERVICE_NAME constant", () => {
      expect(GitHubService.serviceType).toBe(GITHUB_SERVICE_NAME);
    });
  });

  // =========================================================================
  // Instance creation
  // =========================================================================
  describe("instance", () => {
    it("should be constructable", () => {
      const service = new GitHubService();
      expect(service).toBeInstanceOf(GitHubService);
    });

    it("should have name property matching service name", () => {
      const service = new GitHubService();
      expect(service.name).toBe(GITHUB_SERVICE_NAME);
    });

    it("should have a capabilityDescription", () => {
      const service = new GitHubService();
      expect(service.capabilityDescription).toBeTruthy();
      expect(typeof service.capabilityDescription).toBe("string");
      expect(service.capabilityDescription.length).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // Config access before initialization
  // =========================================================================
  describe("getConfig before start", () => {
    it("should throw when accessing config before initialization", () => {
      const service = new GitHubService();
      expect(() => service.getConfig()).toThrow("GitHub service not initialized");
    });
  });

  // =========================================================================
  // GITHUB_SERVICE_NAME constant
  // =========================================================================
  describe("GITHUB_SERVICE_NAME", () => {
    it("should equal 'github'", () => {
      expect(GITHUB_SERVICE_NAME).toBe("github");
    });

    it("should be a non-empty string", () => {
      expect(typeof GITHUB_SERVICE_NAME).toBe("string");
      expect(GITHUB_SERVICE_NAME.length).toBeGreaterThan(0);
    });
  });
});
