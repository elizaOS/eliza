import { describe, expect, it } from "bun:test";
import {
  canonicalRpcBytes,
  hexDecode,
  hexEncode,
  pluginRpcKeyId,
} from "./rpc-mac.js";

const dec = new TextDecoder();

describe("worker RPC MAC helpers", () => {
  it("canonicalizes rpc messages with stable object key ordering", () => {
    const left = canonicalRpcBytes({
      requestId: 42,
      surface: "action",
      target: "action:ship:1",
      args: {
        z: true,
        a: {
          two: 2,
          one: 1,
        },
        list: [{ b: "b", a: "a" }],
      },
    });
    const right = canonicalRpcBytes({
      requestId: 42,
      surface: "action",
      target: "action:ship:1",
      args: {
        list: [{ a: "a", b: "b" }],
        a: {
          one: 1,
          two: 2,
        },
        z: true,
      },
    });

    expect(dec.decode(left)).toBe(
      '42\naction\naction:ship:1\n{"a":{"one":1,"two":2},"list":[{"a":"a","b":"b"}],"z":true}',
    );
    expect(left).toEqual(right);
  });

  it("covers request id, surface, target, and args in the canonical bytes", () => {
    const base = {
      requestId: 1,
      surface: "provider",
      target: "provider:ctx:1",
      args: { message: null, state: null },
    } as const;

    expect(canonicalRpcBytes(base)).not.toEqual(
      canonicalRpcBytes({ ...base, requestId: 2 }),
    );
    expect(canonicalRpcBytes(base)).not.toEqual(
      canonicalRpcBytes({ ...base, surface: "model" }),
    );
    expect(canonicalRpcBytes(base)).not.toEqual(
      canonicalRpcBytes({ ...base, target: "provider:other:1" }),
    );
    expect(canonicalRpcBytes(base)).not.toEqual(
      canonicalRpcBytes({ ...base, args: { message: "changed", state: null } }),
    );
  });

  it("rejects non-finite numbers so hostile args cannot collide with null", () => {
    const base = {
      requestId: 1,
      surface: "action",
      target: "action:ship:1",
    } as const;

    expect(() =>
      canonicalRpcBytes({ ...base, args: { amount: Number.NaN } }),
    ).toThrow(/finite numbers/);
    expect(() =>
      canonicalRpcBytes({ ...base, args: [Number.POSITIVE_INFINITY] }),
    ).toThrow(/finite numbers/);
  });

  it("round-trips lower-case hex and rejects malformed MAC text", () => {
    const bytes = new Uint8Array([0, 1, 15, 16, 254, 255]);

    const encoded = hexEncode(bytes);

    expect(encoded).toBe("00010f10feff");
    expect(hexDecode(encoded)).toEqual(bytes);
    expect(hexDecode("AA10")).toEqual(new Uint8Array([170, 16]));
    expect(() => hexDecode("abc")).toThrow(/malformed hex mac/);
    expect(() => hexDecode("zz")).toThrow(/malformed hex mac/);
  });

  it("derives sanitized per-plugin KMS key ids", () => {
    expect(String(pluginRpcKeyId("Bunny.Search"))).toContain(
      "plugin-rpc-bunny-search",
    );
    expect(String(pluginRpcKeyId("@scope/plugin name!"))).toContain(
      "plugin-rpc-scope-plugin-name",
    );
    expect(() => pluginRpcKeyId("!!!")).toThrow(/letter or digit/);
  });
});
