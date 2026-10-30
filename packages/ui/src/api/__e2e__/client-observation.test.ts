import { expect, it } from "vitest";
import { ClientObservationSupportSession } from "../client-observation";

const id = "11111111-1111-4111-8111-111111111111";
const status = (serverInstanceId = id) => ({
  serverInstanceId,
  clientTurnObservationSupport: { version: 1, optionalFields: ["calendarDay"] },
});
const identity = {
  origin: "https://agent.example",
  ownerId: "owner",
  agentId: "agent",
  sessionId: "session",
  connectionEpoch: 2,
};
const context = {
  view: "calendar",
  revision: 3,
  sensitive: false,
  timeZone: "UTC",
  calendarDay: { date: "2026-10-29", timeZone: "UTC" },
};
it("binds optional observations to one authenticated API process without relearning a replacement", async () => {
  let response = status(),
    reads = 0;
  const peer = new ClientObservationSupportSession(
    identity,
    () => true,
    async () => {
      reads++;
      return response;
    },
  );
  const signal = new AbortController().signal;
  await peer.handshake(signal);
  expect((await peer.context(context, signal)).calendarDay).toEqual(
    context.calendarDay,
  );
  expect(reads).toBe(2);
  response = status("22222222-2222-4222-8222-222222222222");
  expect((await peer.context(context, signal)).calendarDay).toBeUndefined();
  response = status();
  expect((await peer.context(context, signal)).calendarDay).toBeUndefined();
  expect(reads).toBe(3);
});
it("a retired in-flight status cannot serialize optional or ordinary context", async () => {
  let done!: (v: unknown) => void;
  const peer = new ClientObservationSupportSession(
    identity,
    () => true,
    () =>
      new Promise((r) => {
        done = r;
      }),
  );
  const pending = peer.context(context, new AbortController().signal);
  peer.clear();
  done(status());
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
});
it("an unreadable peer preserves ordinary observation and never requests status for a plain turn", async () => {
  let reads = 0;
  const peer = new ClientObservationSupportSession(
    identity,
    () => true,
    async () => {
      reads++;
      throw Error("offline");
    },
  );
  const signal = new AbortController().signal;
  const { calendarDay, ...ordinary } = context;
  expect(await peer.context(ordinary, signal)).toEqual(ordinary);
  expect(reads).toBe(0);
  expect(await peer.context(context, signal)).toEqual(ordinary);
  expect(reads).toBe(1);
});
