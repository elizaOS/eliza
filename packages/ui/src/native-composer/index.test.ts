/**
 * Barrel smoke test: the `@elizaos/ui/native-composer` subpath re-exports the
 * schema constant, the decoder, the reducer, and the client factory, so a native
 * shell importing the one entrypoint gets the whole contract. Pure.
 */

import { describe, expect, it } from "vitest";
import * as api from "./index";

describe("@elizaos/ui/native-composer barrel", () => {
  it("exposes the schema, decoder, reducer, and client entrypoints", () => {
    expect(api.NATIVE_COMPOSER_SCHEMA).toBe("eliza.native-composer/v1");
    expect(typeof api.decodeComposerOperation).toBe("function");
    expect(typeof api.decodeComposerOperationStream).toBe("function");
    expect(typeof api.normalizeComposerAttachment).toBe("function");
    expect(typeof api.applyComposerOperation).toBe("function");
    expect(typeof api.createComposerBridgeClient).toBe("function");
    expect(typeof api.emptyComposerDraft).toBe("function");
  });

  it("the client factory produces a working bridge from the barrel export", () => {
    const client = api.createComposerBridgeClient();
    const result = client.dispatchRaw({
      type: "text.set",
      opId: "1",
      text: "hi",
    });
    expect(result.status).toBe("applied");
    expect(client.getDraft().text).toBe("hi");
  });
});
