/**
 * Pins the spend boundary of admission-gated inbound media enrichment: the
 * flag and the ceiling bindings are checked before the ledger, the ledger is
 * consulted before the provider, every non-claimed admission and every ledger
 * failure skips without calling the provider, and a claim is settled with the
 * provider's real outcome. The ledger and the describe helper are injected
 * fakes; the helper's real typed errors drive the settlement branches.
 */
import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { ElizaError } from "@elizaos/core";
import type {
  AdmitInboundMediaDescriptionInput,
  InboundMediaDescriptionAdmission,
  InboundMediaDescriptionClaim,
  PersonalSharedInboundMediaRepository,
} from "../../../db/repositories/personal-shared-inbound-media";
import { sha256Hex } from "../../oidc/crypto";
import { logger } from "../../utils/logger";
import {
  InboundMediaDescriptionError,
  InboundMediaVisionDisabledError,
} from "./describe-inbound-media";
import {
  DEFAULT_INBOUND_MEDIA_CONNECTOR_DAILY_IMAGES,
  DEFAULT_INBOUND_MEDIA_SENDER_DAILY_IMAGES,
  enrichInboundImageMedia,
  type InboundMediaEnrichmentEnv,
  inboundMediaDigest,
  resolveInboundMediaVisionCeilings,
} from "./inbound-media-enrichment";

const URL_A = "https://media.blooio.com/files/photo-a.jpg";
const URL_B = "https://backend.blooio.com/files/photo-b.png";
const CLAIM: InboundMediaDescriptionClaim = {
  id: "10000000-0000-4000-8000-000000000001",
  claimToken: "10000000-0000-4000-8000-000000000002",
  attempt: 1,
};

const admit = mock(
  async (_input: AdmitInboundMediaDescriptionInput): Promise<InboundMediaDescriptionAdmission> => ({
    kind: "claimed",
    claim: CLAIM,
  }),
);
const complete = mock(async (_claim: InboundMediaDescriptionClaim, _description: string) => true);
const fail = mock(async (_claim: InboundMediaDescriptionClaim, _reason: string) => true);
const repository = { admit, complete, fail } as unknown as PersonalSharedInboundMediaRepository;
const describeMedia = mock(
  async (_env: unknown, _urls: readonly string[]): Promise<string> => "a cat on a keyboard",
);
const deps = { repository, describe: describeMedia };

function enrich(env: InboundMediaEnrichmentEnv = { ELIZA_APP_INBOUND_MEDIA_VISION: "true" }) {
  return enrichInboundImageMedia(
    {
      env,
      platform: "blooio",
      project: "eliza-app",
      connectorAccountId: "+15550001111",
      sourceMessageId: "blooio:eliza-app:message-42",
      organizationId: "00000000-0000-4000-8000-000000000001",
      userId: "00000000-0000-4000-8000-000000000002",
      mediaUrls: [URL_A, URL_B],
    },
    deps,
  );
}

beforeEach(() => {
  admit.mockReset();
  complete.mockReset();
  fail.mockReset();
  describeMedia.mockReset();
  admit.mockResolvedValue({ kind: "claimed", claim: CLAIM });
  complete.mockResolvedValue(true);
  fail.mockResolvedValue(true);
  describeMedia.mockResolvedValue("a cat on a keyboard");
});

describe("resolveInboundMediaVisionCeilings", () => {
  test("unset bindings keep the defaults, while explicit blank bindings fail closed", () => {
    expect(resolveInboundMediaVisionCeilings({})).toEqual({
      senderDailyImages: DEFAULT_INBOUND_MEDIA_SENDER_DAILY_IMAGES,
      connectorDailyImages: DEFAULT_INBOUND_MEDIA_CONNECTOR_DAILY_IMAGES,
    });
    expect(
      resolveInboundMediaVisionCeilings({
        ELIZA_APP_INBOUND_MEDIA_VISION_SENDER_DAILY_IMAGES: "  ",
      }),
    ).toBeNull();
    expect(
      resolveInboundMediaVisionCeilings({
        ELIZA_APP_INBOUND_MEDIA_VISION_CONNECTOR_DAILY_IMAGES: "",
      }),
    ).toBeNull();
  });

  test("non-negative integer bindings tune each ceiling, zero included", () => {
    expect(
      resolveInboundMediaVisionCeilings({
        ELIZA_APP_INBOUND_MEDIA_VISION_SENDER_DAILY_IMAGES: " 7 ",
        ELIZA_APP_INBOUND_MEDIA_VISION_CONNECTOR_DAILY_IMAGES: "0",
      }),
    ).toEqual({ senderDailyImages: 7, connectorDailyImages: 0 });
  });

  test("a malformed binding yields no ceilings at all", () => {
    for (const raw of ["-1", "1.5", "1e3", "unlimited", "12abc", "1000000000000"]) {
      expect(
        resolveInboundMediaVisionCeilings({
          ELIZA_APP_INBOUND_MEDIA_VISION_SENDER_DAILY_IMAGES: raw,
        }),
      ).toBeNull();
      expect(
        resolveInboundMediaVisionCeilings({
          ELIZA_APP_INBOUND_MEDIA_VISION_CONNECTOR_DAILY_IMAGES: raw,
        }),
      ).toBeNull();
    }
  });
});

describe("enrichInboundImageMedia — gates before the ledger", () => {
  test("a dark flag skips before the ledger or provider is touched", async () => {
    expect(await enrich({})).toEqual({ kind: "skipped", reason: "vision_disabled" });
    expect(await enrich({ ELIZA_APP_INBOUND_MEDIA_VISION: "1" })).toEqual({
      kind: "skipped",
      reason: "vision_disabled",
    });
    expect(admit).not.toHaveBeenCalled();
    expect(describeMedia).not.toHaveBeenCalled();
  });

  test("a malformed ceiling binding fails closed before the ledger or provider", async () => {
    const errorSpy = spyOn(logger, "error");
    expect(
      await enrich({
        ELIZA_APP_INBOUND_MEDIA_VISION: "true",
        ELIZA_APP_INBOUND_MEDIA_VISION_SENDER_DAILY_IMAGES: "unlimited",
      }),
    ).toEqual({ kind: "skipped", reason: "invalid_ceilings" });
    expect(admit).not.toHaveBeenCalled();
    expect(describeMedia).not.toHaveBeenCalled();
    expect(
      errorSpy.mock.calls.some(([message]) => String(message).includes("ceiling bindings")),
    ).toBe(true);
    errorSpy.mockRestore();
  });

  test("the ledger is asked with the exact identity, digest, image count, and ceilings", async () => {
    await enrich({
      ELIZA_APP_INBOUND_MEDIA_VISION: "true",
      ELIZA_APP_INBOUND_MEDIA_VISION_SENDER_DAILY_IMAGES: "3",
    });
    expect(admit).toHaveBeenCalledTimes(1);
    expect(admit.mock.calls[0]?.[0]).toEqual({
      platform: "blooio",
      project: "eliza-app",
      connectorAccountId: "+15550001111",
      sourceMessageId: "blooio:eliza-app:message-42",
      organizationId: "00000000-0000-4000-8000-000000000001",
      userId: "00000000-0000-4000-8000-000000000002",
      mediaDigest: await sha256Hex(JSON.stringify([URL_A, URL_B])),
      imageCount: 2,
      ceilings: {
        senderDailyImages: 3,
        connectorDailyImages: DEFAULT_INBOUND_MEDIA_CONNECTOR_DAILY_IMAGES,
      },
    });
  });

  test("media-list framing cannot collide across URL boundaries", async () => {
    expect(await inboundMediaDigest(["https://media.blooio.com/a\nb"])).not.toBe(
      await inboundMediaDigest(["https://media.blooio.com/a", "b"]),
    );
  });

  test("an unavailable ledger skips without spending and reports the fault", async () => {
    const errorSpy = spyOn(logger, "error");
    admit.mockRejectedValue(
      new ElizaError("connection refused", {
        code: "INBOUND_MEDIA_ADMISSION_STORAGE_FAILURE",
      }),
    );
    expect(await enrich()).toEqual({ kind: "skipped", reason: "admission_unavailable" });
    expect(describeMedia).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(fail).not.toHaveBeenCalled();
    const fault = errorSpy.mock.calls.find(([message]) =>
      String(message).includes("admission ledger unavailable"),
    );
    expect(fault?.[1]).toMatchObject({ error: "connection refused" });
    errorSpy.mockRestore();
  });
});

describe("enrichInboundImageMedia — ledger decisions", () => {
  test("a stored description is reused without calling the provider", async () => {
    admit.mockResolvedValue({ kind: "reused", description: "the earlier description" });
    expect(await enrich()).toEqual({
      kind: "described",
      description: "the earlier description",
      reused: true,
    });
    expect(describeMedia).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  test("every non-claimed decision skips without calling the provider", async () => {
    const cases: Array<[InboundMediaDescriptionAdmission, string]> = [
      [{ kind: "in_flight" }, "in_flight"],
      [{ kind: "previously_failed", reason: "media_fetch_failed" }, "previously_failed"],
      [{ kind: "identity_mismatch" }, "identity_mismatch"],
      [{ kind: "media_mismatch" }, "media_mismatch"],
      [{ kind: "exhausted", scope: "sender", limit: 20, used: 20, requested: 2 }, "exhausted"],
      [
        { kind: "exhausted", scope: "connector", limit: 1000, used: 999, requested: 2 },
        "exhausted",
      ],
    ];
    for (const [decision, reason] of cases) {
      admit.mockResolvedValue(decision);
      expect(await enrich()).toEqual({ kind: "skipped", reason: reason as never });
    }
    expect(describeMedia).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(fail).not.toHaveBeenCalled();
  });
});

describe("enrichInboundImageMedia — behind a claim", () => {
  test("a described claim is completed with the provider's text", async () => {
    expect(await enrich()).toEqual({
      kind: "described",
      description: "a cat on a keyboard",
      reused: false,
    });
    expect(describeMedia).toHaveBeenCalledTimes(1);
    expect(describeMedia.mock.calls[0]?.[1]).toEqual([URL_A, URL_B]);
    expect(complete).toHaveBeenCalledWith(CLAIM, "a cat on a keyboard");
    expect(fail).not.toHaveBeenCalled();
  });

  test("a typed enrichment failure is recorded against the claim and skips", async () => {
    const errorSpy = spyOn(logger, "error");
    describeMedia.mockRejectedValue(
      new InboundMediaDescriptionError("Inbound media body read failed", "media_read_failed"),
    );
    expect(await enrich()).toEqual({ kind: "skipped", reason: "description_failed" });
    expect(fail).toHaveBeenCalledWith(CLAIM, "media_read_failed");
    expect(complete).not.toHaveBeenCalled();
    const degrade = errorSpy.mock.calls.find(([message]) =>
      String(message).includes("inbound media description failed"),
    );
    expect(degrade?.[1]).toMatchObject({ reason: "media_read_failed", claimId: CLAIM.id });
    errorSpy.mockRestore();
  });

  test("a missing provider behind an enabled flag is recorded so redeliveries do not re-claim", async () => {
    const errorSpy = spyOn(logger, "error");
    describeMedia.mockRejectedValue(
      new InboundMediaVisionDisabledError("Inbound media vision has no configured provider"),
    );
    expect(await enrich()).toEqual({ kind: "skipped", reason: "vision_disabled" });
    expect(fail).toHaveBeenCalledWith(CLAIM, "vision_disabled");
    expect(
      errorSpy.mock.calls.some(([message]) =>
        String(message).includes("without a configured provider"),
      ),
    ).toBe(true);
    errorSpy.mockRestore();
  });

  test("an untyped provider-path failure propagates and leaves the claim to its lease", async () => {
    const bug = new Error("bug");
    describeMedia.mockRejectedValue(bug);
    await expect(enrich()).rejects.toBe(bug);
    expect(complete).not.toHaveBeenCalled();
    expect(fail).not.toHaveBeenCalled();
  });

  test("a lost or unwritable settlement cannot inject an uncommitted description", async () => {
    const errorSpy = spyOn(logger, "error");
    const warnSpy = spyOn(logger, "warn");
    complete.mockResolvedValue(false);
    expect(await enrich()).toEqual({ kind: "skipped", reason: "settlement_failed" });
    expect(
      warnSpy.mock.calls.some(([message]) => String(message).includes("reclaimed before")),
    ).toBe(true);

    complete.mockRejectedValue(
      new ElizaError("ledger down", {
        code: "INBOUND_MEDIA_ADMISSION_STORAGE_FAILURE",
      }),
    );
    expect(await enrich()).toEqual({ kind: "skipped", reason: "settlement_failed" });
    const settlementFault = errorSpy.mock.calls.find(([message]) =>
      String(message).includes("failed to settle"),
    );
    expect(settlementFault?.[1]).toMatchObject({ error: "ledger down" });
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });
});
