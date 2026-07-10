/**
 * Opus <-> PCM transcode seam (contract §10, Phase-4-ready, stubbed in P1).
 *
 * The canonical uplink/downlink codec is PCM16 (matches Deepgram Flux ingest
 * and Cartesia output exactly, zero transcode). Opus is the FUTURE codec for
 * the BLE wearable mic uplink and for bandwidth-constrained cellular downlink.
 * Those paths are documented seams, not implemented in Phase 1 — the capture
 * device layer already owns Opus decode today, so the server transcode is a
 * fallback that Phase 4 wires with a real codec.
 *
 * These stubs fail LOUD if invoked in Phase 1 rather than silently returning
 * wrong bytes: an `opus` negotiation reaching here before Phase 4 is a wiring
 * bug, and a fake transcode would corrupt a paid provider stream.
 */

export class OpusTranscodeNotImplementedError extends Error {
  constructor(direction: "opus_to_pcm" | "pcm_to_opus") {
    super(
      `Opus transcode (${direction}) is a Phase-4 seam and is not implemented in Phase 1; ` +
        `negotiate pcm16 for uplink and downlink until the codec is wired`,
    );
    this.name = "OpusTranscodeNotImplementedError";
  }
}

/** Decode inbound Opus packets to PCM16 for Deepgram Flux. Phase-4 seam. */
export function decodeOpusToPcm16(_opus: Uint8Array): never {
  throw new OpusTranscodeNotImplementedError("opus_to_pcm");
}

/** Encode Cartesia PCM16 to Opus for the downlink. Phase-4 seam. */
export function encodePcm16ToOpus(_pcm: Uint8Array): never {
  throw new OpusTranscodeNotImplementedError("pcm_to_opus");
}

/** True once a real Opus codec is wired (Phase 4). Phase 1: always false. */
export function isOpusTranscodeAvailable(): boolean {
  return false;
}
