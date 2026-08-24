import { describe, expect, it } from "vitest";
import { publicUrlForR2Key, putPublicObject } from "./r2-public-object.js";

describe("publicUrlForR2Key", () => {
  it("uses R2_PUBLIC_HOST when set", () => {
    const env = { BLOB: null as never, R2_PUBLIC_HOST: "cdn.example.com" };
    expect(publicUrlForR2Key(env, "path/file.txt")).toBe("https://cdn.example.com/path/file.txt");
  });

  it("falls back to blob.eliza.app", () => {
    const env = { BLOB: null as never, R2_PUBLIC_HOST: "" };
    expect(publicUrlForR2Key(env, "a/b")).toBe("https://blob.eliza.app/a/b");
    const env2 = { BLOB: null as never } as never;
    expect(publicUrlForR2Key(env2, "a/b")).toBe("https://blob.eliza.app/a/b");
  });
});

describe("putPublicObject", () => {
  it("puts and returns url", async () => {
    const put = async () => undefined;
    const env = { BLOB: { put } as never, R2_PUBLIC_HOST: "cdn.example.com" };
    const res = await putPublicObject(env, {
      key: "k1",
      body: new Uint8Array([1, 2]),
      contentType: "text/plain",
    });
    expect(res.key).toBe("k1");
    expect(res.url).toBe("https://cdn.example.com/k1");
  });
});
