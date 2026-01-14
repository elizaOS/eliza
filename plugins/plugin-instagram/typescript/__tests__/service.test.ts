import { beforeEach, describe, expect, it } from "vitest";
import { MAX_DM_LENGTH } from "../src/constants";
import { InstagramService, splitMessage } from "../src/service";

describe("InstagramService", () => {
  let service: InstagramService;

  beforeEach(() => {
    service = new InstagramService();
  });

  describe("service creation", () => {
    it("should create service with correct service type", () => {
      expect(InstagramService.serviceType).toBe("instagram");
    });

    it("should not be running initially", () => {
      expect(service.getIsRunning()).toBe(false);
    });

    it("should not have logged in user initially", () => {
      expect(service.getLoggedInUser()).toBeNull();
    });
  });

  describe("validation", () => {
    it("should fail validation without config", () => {
      expect(service.validateConfig()).toBe(false);
    });
  });

  describe("start/stop", () => {
    it("should throw when starting without initialization", async () => {
      await expect(service.startService()).rejects.toThrow(
        "Instagram service not initialized",
      );
    });
  });

  describe("operations without running", () => {
    it("should throw when sending DM without running", async () => {
      await expect(
        service.sendDirectMessage("thread-1", "Hello"),
      ).rejects.toThrow("Instagram service is not running");
    });

    it("should throw when posting comment without running", async () => {
      await expect(service.postComment(12345, "Nice!")).rejects.toThrow(
        "Instagram service is not running",
      );
    });

    it("should throw when liking media without running", async () => {
      await expect(service.likeMedia(12345)).rejects.toThrow(
        "Instagram service is not running",
      );
    });

    it("should throw when following user without running", async () => {
      await expect(service.followUser(12345)).rejects.toThrow(
        "Instagram service is not running",
      );
    });
  });
});

describe("splitMessage", () => {
  it("should not split short messages", () => {
    const msg = "Hello, world!";
    const parts = splitMessage(msg, MAX_DM_LENGTH);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toBe(msg);
  });

  it("should split long messages", () => {
    const msg = "a".repeat(MAX_DM_LENGTH + 500);
    const parts = splitMessage(msg, MAX_DM_LENGTH);
    expect(parts.length).toBeGreaterThan(1);

    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(MAX_DM_LENGTH);
    }
  });

  it("should preserve total content", () => {
    const msg = "a".repeat(MAX_DM_LENGTH + 500);
    const parts = splitMessage(msg, MAX_DM_LENGTH);
    const joined = parts.join("");
    expect(joined).toBe(msg);
  });

  it("should split multiline messages correctly", () => {
    const lines = Array.from(
      { length: 100 },
      (_, i) => `Line ${i}: Some content`,
    );
    const msg = lines.join("\n");
    const parts = splitMessage(msg, MAX_DM_LENGTH);

    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(MAX_DM_LENGTH);
    }
  });

  it("should handle empty messages", () => {
    const parts = splitMessage("", MAX_DM_LENGTH);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toBe("");
  });
});
