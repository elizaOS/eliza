// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import {
  clearElizaApiBase,
  clearElizaApiToken,
  getElizaApiBase,
  getElizaApiToken,
  setElizaApiBase,
  setElizaApiToken,
} from "../../src/utils/eliza-globals";

declare global {
  interface Window {
    __ELIZA_API_BASE__?: string;
    __ELIZA_API_TOKEN__?: string;
  }
}

describe("eliza-globals", () => {
  afterEach(() => {
    delete window.__ELIZA_API_BASE__;
    delete window.__ELIZA_API_TOKEN__;
  });

  describe("getElizaApiBase / setElizaApiBase / clearElizaApiBase", () => {
    it("returns undefined when no base is set", () => {
      expect(getElizaApiBase()).toBeUndefined();
    });

    it("returns the value after setElizaApiBase", () => {
      setElizaApiBase("http://localhost:3000");
      expect(getElizaApiBase()).toBe("http://localhost:3000");
    });

    it("returns undefined after clearElizaApiBase", () => {
      setElizaApiBase("http://localhost:3000");
      clearElizaApiBase();
      expect(getElizaApiBase()).toBeUndefined();
    });
  });

  describe("getElizaApiToken / setElizaApiToken / clearElizaApiToken", () => {
    it("returns undefined when no token is set", () => {
      expect(getElizaApiToken()).toBeUndefined();
    });

    it("returns the value after setElizaApiToken", () => {
      setElizaApiToken("test-token-123");
      expect(getElizaApiToken()).toBe("test-token-123");
    });

    it("returns undefined after clearElizaApiToken", () => {
      setElizaApiToken("test-token-123");
      clearElizaApiToken();
      expect(getElizaApiToken()).toBeUndefined();
    });
  });
});
