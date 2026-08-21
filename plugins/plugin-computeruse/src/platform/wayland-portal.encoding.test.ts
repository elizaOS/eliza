/** Exercises canonical and malformed Wayland portal file URI decoding. */
import { describe, expect, test } from "vitest";
import { portalFileUriToPath } from "./wayland-portal.ts";

describe("wayland portal file URI encoding", () => {
  test("canonical percent-encoded space still decodes to a local path", () => {
    expect(portalFileUriToPath("file:///tmp/wayland%20shot.png")).toBe(
      "/tmp/wayland shot.png",
    );
  });

  test("canonical percent-encoded hyphen still decodes", () => {
    expect(portalFileUriToPath("file:///tmp/shot%2D1.png")).toBe(
      "/tmp/shot-1.png",
    );
  });

  test.each(["%", "%2", "%ZZ", "%E0%A4"])(
    "rejects malformed path encoding %s as a typed portal URI error",
    (token) => {
      expect(() => portalFileUriToPath(`file:///tmp/${token}`)).toThrow(
        /malformed file URI/i,
      );
      try {
        portalFileUriToPath(`file:///tmp/${token}`);
        throw new Error("expected throw");
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect(error).not.toBeInstanceOf(URIError);
      }
    },
  );

  test("non-file URIs remain a typed non-file error", () => {
    expect(() => portalFileUriToPath("document://portal/shot.png")).toThrow(
      /non-file URI/i,
    );
  });
});
