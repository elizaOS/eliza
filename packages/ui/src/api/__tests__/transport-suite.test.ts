/**
 * Unit tests for UI HTTP request transport and parsing helpers.
 * Validates headers conversion, HTTP method body rules, body coercion, and streaming detection.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bodyToString,
  fetchAgentTransport,
  headersToRecord,
  isStreamingRequest,
  methodAllowsBody,
} from "../transport.ts";

describe("transport helpers", () => {
  describe("headersToRecord", () => {
    it("returns empty object for undefined headers", () => {
      expect(headersToRecord(undefined)).toEqual({});
    });

    it("converts record object to key-value pairs", () => {
      const headers = {
        "Content-Type": "application/json",
        Authorization: "Bearer token",
      };
      const record = headersToRecord(headers);
      expect(record["content-type"]).toBe("application/json");
      expect(record.authorization).toBe("Bearer token");
    });

    it("converts Headers instance to record", () => {
      const headers = new Headers();
      headers.set("X-Custom-Header", "custom-val");
      const record = headersToRecord(headers);
      expect(record["x-custom-header"]).toBe("custom-val");
    });
  });

  describe("methodAllowsBody", () => {
    it("rejects GET and HEAD methods case-insensitively", () => {
      expect(methodAllowsBody("GET")).toBe(false);
      expect(methodAllowsBody("get")).toBe(false);
      expect(methodAllowsBody("HEAD")).toBe(false);
      expect(methodAllowsBody("head")).toBe(false);
    });

    it("allows POST, PUT, PATCH, DELETE methods", () => {
      expect(methodAllowsBody("POST")).toBe(true);
      expect(methodAllowsBody("PUT")).toBe(true);
      expect(methodAllowsBody("PATCH")).toBe(true);
      expect(methodAllowsBody("DELETE")).toBe(true);
    });
  });

  describe("bodyToString", () => {
    it("preserves null and undefined as distinct values", () => {
      expect(bodyToString(null)).toBeNull();
      expect(bodyToString(undefined)).toBeUndefined();
    });

    it("returns raw strings unmodified", () => {
      expect(bodyToString("test payload")).toBe("test payload");
    });

    it("converts URLSearchParams to string representation", () => {
      const params = new URLSearchParams({ key: "val", tag: "123" });
      expect(bodyToString(params)).toBe("key=val&tag=123");
    });

    it("returns undefined for unsupported body types", () => {
      expect(bodyToString({} as unknown as BodyInit)).toBeUndefined();
    });
  });

  describe("isStreamingRequest", () => {
    it("detects streaming via Accept header", () => {
      expect(
        isStreamingRequest("/api/chat", { Accept: "text/event-stream" }),
      ).toBe(true);
      expect(
        isStreamingRequest("/api/chat", {
          accept: "TEXT/EVENT-STREAM; charset=utf-8",
        }),
      ).toBe(true);
    });

    it("detects streaming via /stream URL endpoint path", () => {
      expect(isStreamingRequest("/api/v1/chat/stream", undefined)).toBe(true);
      expect(
        isStreamingRequest("https://example.com/api/stream", undefined),
      ).toBe(true);
    });

    it("returns false for non-streaming endpoints and headers", () => {
      expect(
        isStreamingRequest("/api/v1/chat", { Accept: "application/json" }),
      ).toBe(false);
    });
  });

  describe("fetchAgentTransport", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("delegates to global fetch", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response("ok"));
      const res = await fetchAgentTransport.request(
        "https://api.example.com/test",
        { method: "GET" },
      );

      expect(fetchSpy).toHaveBeenCalledWith("https://api.example.com/test", {
        method: "GET",
      });
      expect(await res.text()).toBe("ok");
    });
  });
});
