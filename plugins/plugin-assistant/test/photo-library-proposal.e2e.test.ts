import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolveOwnerEntityIdOrDefault } from "@elizaos/core";
import { expect, test } from "vitest";
import { createTestRuntime } from "../../../packages/testing/src/pglite-runtime.ts";
import { createAssistantPlugin } from "../src/index.ts";
import {
  DeviceActionService,
  deviceProposalDigest,
} from "../src/services/device-actions/service.ts";
import { withOwnerDeviceActionTurn } from "./device-owner-turn.ts";

test("a phone that negotiated photos.library.v1 receives library proposals and returns their checked result", async () => {
  const fixture = await createTestRuntime({
    characterName: "PhotoLibraryProposal",
    plugins: [createAssistantPlugin()],
  });
  const runtime = fixture.runtime;
  const service = new DeviceActionService(runtime);
  const credential = {
    subjectUserId: resolveOwnerEntityIdOrDefault(runtime),
    installationId: randomUUID(),
    deviceKey: "a".repeat(64),
    capabilities: ["photos.library.v1"],
  };
  const search = { type: "photo_library_search", kind: "image", limit: 5 };
  try {
    await service.register(credential, "Photo library fixture");
    // A phone without the capability is never sent a library proposal.
    const other = {
      ...credential,
      installationId: randomUUID(),
      deviceKey: "b".repeat(64),
      capabilities: ["photos.view.v1"],
    };
    await service.register(other, "Other fixture");
    await expect(
      withOwnerDeviceActionTurn(runtime, other, () =>
        service.propose(other, search, "library-search-other", "Fixture"),
      ),
    ).rejects.toThrow("capability unavailable");
    // Fields the phone does not accept are refused before anything is queued.
    await expect(
      withOwnerDeviceActionTurn(runtime, credential, () =>
        service.propose(
          credential,
          { type: "photo_library_search", text: "beach" },
          "library-search-text",
          "Fixture",
        ),
      ),
    ).rejects.toThrow("Invalid photo library operation");

    await withOwnerDeviceActionTurn(runtime, credential, () =>
      service.propose(credential, search, "library-search", "Fixture"),
    );
    await withOwnerDeviceActionTurn(runtime, credential, () =>
      service.propose(
        credential,
        { type: "photo_library_select", ids: ["lib:i:42:1700000000000"] },
        "library-select",
        "Fixture",
      ),
    );
    const proposals = await service.list(credential);
    expect(
      proposals.map(({ payload }) => payload.operation.type).sort(),
    ).toEqual(["photo_library_search", "photo_library_select"]);
    const proposal = proposals.find(
      ({ payload }) => payload.operation.type === "photo_library_search",
    );
    assert(proposal, "Expected the search proposal");
    const digest = deviceProposalDigest(proposal);
    await service.decide(credential, proposal.id, digest, true);
    const claim = await service.claim(credential, proposal.id, digest);
    assert(claim.execution, "Expected one execution claim");
    const item = {
      id: "lib:i:42:1700000000000",
      revision: "rev-s1-1",
      kind: "image",
      takenAt: 1700000000000,
      width: 4000,
      height: 3000,
    };
    const receipt = {
      outcome: "applied",
      operationId: "device-library-1",
      result: {
        kind: "photo_library_search",
        scope: "full",
        items: [item],
        more: false,
      },
    };
    // A file name is never part of what the model may receive.
    await expect(
      service.receipt(
        credential,
        proposal.id,
        digest,
        claim.execution.attemptId,
        {
          ...receipt,
          result: {
            ...receipt.result,
            items: [{ ...item, name: "IMG_0042.jpg" }],
          },
        },
      ),
    ).rejects.toThrow("Invalid photo library receipt");
    await expect(
      service.receipt(
        credential,
        proposal.id,
        digest,
        claim.execution.attemptId,
        receipt,
      ),
    ).resolves.toMatchObject({
      state: "done",
      execution: { providerReceipt: receipt },
    });
  } finally {
    await fixture.cleanup();
  }
});
