/** Exercises every unsupported S3 adapter operation through the real Worker shim. */
import { expect, test } from "vitest";
import { Storage } from "./brighter-storage-adapter-s3";

test.each([
  "write",
  "read",
  "stat",
  "exists",
  "remove",
  "list",
  "presign",
] as const)("S3 %s rejects unconfigured Worker storage", (method) => {
  expect(() => Storage()[method]()).toThrow(
    /unavailable in the Cloudflare Worker bundle/,
  );
});
