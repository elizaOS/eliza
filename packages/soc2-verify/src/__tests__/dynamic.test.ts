import { describe, expect, it } from "vitest";
import {
  auditDispatcherEmits,
  auditRedaction,
  kmsHmacRoundtrip,
  kmsRoundtrip,
  kmsSignatureRoundtrip,
} from "../controls/dynamic.js";

const ctx = { elizaRoot: process.cwd(), outerRoot: process.cwd() };

describe("dynamic SOC2 checks", () => {
  it("KMS AEAD round-trip passes", async () => {
    const r = await kmsRoundtrip.run(ctx);
    expect(r.status).toBe("pass");
  });

  it("KMS HMAC round-trip passes", async () => {
    const r = await kmsHmacRoundtrip.run(ctx);
    expect(r.status).toBe("pass");
  });

  it("KMS Ed25519 sign+verify passes", async () => {
    const r = await kmsSignatureRoundtrip.run(ctx);
    expect(r.status).toBe("pass");
  });

  it("Audit dispatcher emits to in-memory sink", async () => {
    const r = await auditDispatcherEmits.run(ctx);
    expect(r.status).toBe("pass");
  });

  it("Audit redaction strips disallowed PII", async () => {
    const r = await auditRedaction.run(ctx);
    expect(r.status).toBe("pass");
  });
});
