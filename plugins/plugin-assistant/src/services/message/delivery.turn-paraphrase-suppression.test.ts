/**
 * Exercises turn-scoped paraphrase suppression through the real
 * `wrapSingleTurnVisibleCallback` delivery funnel with strict private
 * fixtures: a near-identical second reply is suppressed for Korean and Latin
 * text alike, while a genuinely different progress update still delivers.
 * Deterministic; no runtime, model, or store.
 */

import type { Content, HandlerCallback, Memory, UUID } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { wrapSingleTurnVisibleCallback } from "./delivery.ts";

const AGENT_ID = "99999999-9999-9999-9999-999999999999" as UUID;
const ROOM_ID = "99999999-9999-9999-9999-999999999998" as UUID;

const KO_SUPPRESS_FIRST =
  "readme의 설치 섹션은 15줄이고 설치 단계와 주의 사항을 함께 다룹니다. 필요하면 예시도 들어 있습니다.";
const KO_SUPPRESS_SECOND =
  "readme의 설치 섹션은 15줄이고 설치 단계와 주의 사항을 같이 다룹니다. 필요하면 예시도 들어 있습니다.";
const KO_DIFFERENT_SECOND =
  "readme의 문제 해결 섹션은 42줄이고 오류 코드와 해결 방법을 함께 다룹니다. 필요하면 예시도 들어 있습니다.";
const EN_SUPPRESS_FIRST =
  "The readme has a new Install section (15 lines). It covers the install steps and the caveats.";
const EN_SUPPRESS_SECOND =
  "The readme has a new Install section (15 lines). It covers the install steps and the limitations.";
const EN_DIFFERENT_SECOND =
  "The readme has a new Troubleshooting section (42 lines). It covers error codes and fixes.";

function makeHarness() {
  const delivered: string[] = [];
  const inner: HandlerCallback = async (response: Content) => {
    delivered.push(response.text ?? "");
    return [];
  };
  const deliver = wrapSingleTurnVisibleCallback(
    {
      agentId: AGENT_ID,
      getSetting: () => "false",
      logger: { debug() {}, warn() {}, error() {} },
      reportError() {},
    },
    {
      id: "99999999-9999-9999-9999-999999999997" as UUID,
      agentId: AGENT_ID,
      roomId: ROOM_ID,
      entityId: AGENT_ID,
      content: { text: "turn under test" },
    } as Memory,
    inner,
  );
  return {
    send: (text: string) => deliver({ text }),
    delivered,
  };
}

describe("wrapSingleTurnVisibleCallback paraphrase suppression", () => {
  it("suppresses a near-identical Korean rewording within the turn", async () => {
    const harness = makeHarness();
    await harness.send(KO_SUPPRESS_FIRST);
    expect(harness.delivered).toEqual([KO_SUPPRESS_FIRST]);
    await harness.send(KO_SUPPRESS_SECOND);
    expect(harness.delivered).toEqual([KO_SUPPRESS_FIRST]);
  });

  it("keeps a genuinely different Korean progress update flowing", async () => {
    const harness = makeHarness();
    await harness.send(KO_SUPPRESS_FIRST);
    await harness.send(KO_DIFFERENT_SECOND);
    expect(harness.delivered).toEqual([KO_SUPPRESS_FIRST, KO_DIFFERENT_SECOND]);
  });

  it("suppresses a near-identical Latin rewording within the turn", async () => {
    const harness = makeHarness();
    await harness.send(EN_SUPPRESS_FIRST);
    expect(harness.delivered).toEqual([EN_SUPPRESS_FIRST]);
    await harness.send(EN_SUPPRESS_SECOND);
    expect(harness.delivered).toEqual([EN_SUPPRESS_FIRST]);
  });

  it("keeps a genuinely different Latin progress update flowing", async () => {
    const harness = makeHarness();
    await harness.send(EN_SUPPRESS_FIRST);
    await harness.send(EN_DIFFERENT_SECOND);
    expect(harness.delivered).toEqual([EN_SUPPRESS_FIRST, EN_DIFFERENT_SECOND]);
  });
});
