import { describe, expect, it } from "vitest";
import { resolveTrustedMediaCaptureOrigin } from "./trusted-media-origin";

describe("trusted native media origin", () => {
  it("trusts only the exact explicit loopback renderer origin", () => {
    expect(
      resolveTrustedMediaCaptureOrigin(
        "http://127.0.0.1:2338/chat?apiBase=http://127.0.0.1:32437",
      ),
    ).toBe("http://127.0.0.1:2338");
    expect(resolveTrustedMediaCaptureOrigin("http://localhost:2338/")).toBe(
      "http://localhost:2338",
    );

    expect(resolveTrustedMediaCaptureOrigin("https://127.0.0.1:2338/")).toBeNull();
    expect(resolveTrustedMediaCaptureOrigin("http://127.0.0.1/")).toBeNull();
    expect(resolveTrustedMediaCaptureOrigin("http://example.com:2338/")).toBeNull();
    expect(resolveTrustedMediaCaptureOrigin("file:///tmp/index.html")).toBeNull();
  });
});
