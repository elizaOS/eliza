/** Proves cloned-voice deletion converges after an external-success/local-write retry split. */

import { expect, mock, test } from "bun:test";

const deleteProviderVoice = mock(async () => {
  throw { statusCode: 404 };
});
const where = mock(async () => undefined);
const set = mock(() => ({ where }));
const update = mock(() => ({ set }));

mock.module("../../db/client", () => ({
  dbRead: {},
  dbWrite: { update },
}));
mock.module("./elevenlabs", () => ({
  getElevenLabsService: () => ({ deleteVoice: deleteProviderVoice }),
}));
mock.module("../utils/logger", () => ({
  logger: { info: mock(() => undefined) },
}));

const { VoiceCloningService } = await import("./voice-cloning");

test("treats an already-missing ElevenLabs voice as success and tombstones the local row", async () => {
  const service = new VoiceCloningService();
  service.getVoiceById = mock(async () => ({
    id: "voice-1",
    elevenlabsVoiceId: "provider-voice-1",
    samples: [],
  })) as typeof service.getVoiceById;

  await expect(service.deleteVoice("voice-1", "org-1")).resolves.toBeUndefined();
  expect(deleteProviderVoice).toHaveBeenCalledWith("provider-voice-1");
  expect(update).toHaveBeenCalledTimes(1);
  expect(set).toHaveBeenCalledWith(
    expect.objectContaining({ isActive: false, updatedAt: expect.any(Date) }),
  );
  expect(where).toHaveBeenCalledTimes(1);
});
