/** Exercises canonical namespace admission at the control client and wire parsers without a remote service. */
import { describe, expect, it } from "vitest";
import { SyntheticControlClient } from "./client.js";
import {
  parseSyntheticControlRequest,
  parseSyntheticControlResponse,
} from "./codec.js";
import { createSyntheticControlHandler } from "./handler.js";

const invalidNamespaces = [
  " leading",
  "trailing ",
  "line\nbreak",
  "nul\u0000byte",
];
const token = "local-fixture-control-token";
describe("canonical control namespace", () => {
  it.each(invalidNamespaces)(
    "rejects a noncanonical namespace before creating a client or handler: %j",
    (namespace) => {
      expect(
        () =>
          new SyntheticControlClient({
            baseUrl: "http://127.0.0.1:1",
            namespace,
            token,
          }),
      ).toThrow(/namespace/);
      expect(() =>
        createSyntheticControlHandler({
          namespace,
          token,
          authority: {
            generation: () => 0,
            execute: async () => {
              throw new Error("must not dispatch");
            },
          },
        }),
      ).toThrow(/namespace/);
    },
  );
  it.each(invalidNamespaces)(
    "rejects noncanonical request and response envelopes: %j",
    (namespace) => {
      expect(() =>
        parseSyntheticControlRequest({
          version: 1,
          namespace,
          commandId: "fixture",
          command: { type: "health" },
        }),
      ).toThrow(/namespace/);
      expect(() =>
        parseSyntheticControlResponse({
          version: 1,
          namespace,
          commandId: "fixture",
          ok: true,
          generation: 0,
          data: null,
        }),
      ).toThrow(/namespace/);
    },
  );
  it("preserves the complete canonical Unicode namespace in both wire directions", () => {
    const namespace = "review/提醒-🙂";
    expect(
      parseSyntheticControlRequest({
        version: 1,
        namespace,
        commandId: "fixture",
        command: { type: "health" },
      }).namespace,
    ).toBe(namespace);
    expect(
      parseSyntheticControlResponse({
        version: 1,
        namespace,
        commandId: "fixture",
        ok: true,
        generation: 0,
        data: null,
      }).namespace,
    ).toBe(namespace);
    expect(
      new SyntheticControlClient({
        baseUrl: "http://127.0.0.1:1",
        namespace,
        token,
      }).namespace,
    ).toBe(namespace);
  });
});
