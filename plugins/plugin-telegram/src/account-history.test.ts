/**
 * Exercises the production personal-history pager through actual GramJS request
 * and response objects. Only provider RPC responses are controlled; no live
 * Telegram account, local bot history, or history implementation is substituted.
 */
import { Api, TelegramClient } from "telegram";
import { BinaryReader } from "telegram/extensions/BinaryReader.js";
import { readBigIntFromBuffer } from "telegram/Helpers.js";
import { StringSession } from "telegram/sessions/index.js";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/core", async () => vi.importActual("@elizaos/core"));

import { readTelegramAccountHistory } from "./account-history";

const peer = new Api.InputPeerSelf();
const userPeer = new Api.PeerUser({
  userId: readBigIntFromBuffer(Buffer.from([71])),
});
function message(id: number, text = `provider message ${id}`): Api.Message {
  return new Api.Message({
    id,
    peerId: userPeer,
    fromId: userPeer,
    date: 1700000000 + id,
    message: text,
  });
}
function page(messages: Api.TypeMessage[]): Api.messages.Messages {
  return new Api.messages.Messages({ messages, users: [], chats: [] });
}
function transport(rows: Api.TypeMessage[]) {
  const client = new TelegramClient(
    new StringSession(""),
    12345,
    "test-api-hash",
    {},
  );
  const requests: Api.messages.GetHistory[] = [];
  const rpc = vi.spyOn(client, "invoke").mockImplementation(async (request) => {
    if (!(request instanceof Api.messages.GetHistory))
      throw new Error(`Unexpected RPC ${request.className}`);
    const decoded: unknown = new BinaryReader(
      request.getBytes(),
    ).tgReadObject();
    if (!(decoded instanceof Api.messages.GetHistory))
      throw new Error(
        "History request did not roundtrip through the actual TL codec",
      );
    requests.push(decoded);
    return page(
      rows
        .filter((row) => request.offsetId === 0 || row.id < request.offsetId)
        .slice(0, request.limit),
    );
  });
  return { client, requests, rpc };
}
afterEach(() => vi.restoreAllMocks());

describe("personal MTProto complete history", () => {
  it("reaches the final page with exact provider ordering and complete text", async () => {
    const sentinel = `oldest required fact: ${"😀whole source ".repeat(900)}`;
    const rows = Array.from({ length: 205 }, (_, i) =>
      message(205 - i, i === 204 ? sentinel : `row ${205 - i}`),
    );
    const { client, requests } = transport(rows);
    const result = await readTelegramAccountHistory(client, peer);
    expect(result.map((row) => row.id)).toEqual(rows.map((row) => row.id));
    expect(result.at(-1)).toMatchObject({
      message: sentinel,
      peerId: userPeer,
      fromId: userPeer,
    });
    expect(requests.map((request) => request.offsetId)).toEqual([0, 106, 6, 1]);
    expect(
      requests.every((request) => request instanceof Api.messages.GetHistory),
    ).toBe(true);
  });

  it("confirms exhaustion after an exact provider-page boundary", async () => {
    const { client, requests } = transport(
      Array.from({ length: 200 }, (_, i) => message(200 - i)),
    );
    expect(await readTelegramAccountHistory(client, peer)).toHaveLength(200);
    expect(requests.at(-1)?.offsetId).toBe(1);
  });

  it("does not confuse a short page or deleted placeholder with exhaustion", async () => {
    const { client, rpc } = transport([]);
    rpc.mockResolvedValueOnce(
      page([message(5), new Api.MessageEmpty({ id: 4 })]),
    );
    rpc.mockResolvedValueOnce(page([message(2, "last-page fact")]));
    rpc.mockResolvedValueOnce(page([]));
    expect(
      (await readTelegramAccountHistory(client, peer)).map((row) => row.id),
    ).toEqual([5, 4, 2]);
  });

  it("rejects a non-progress page instead of presenting its prefix as complete", async () => {
    const { client, rpc } = transport([]);
    rpc.mockResolvedValue(page([message(9), message(8)]));
    await expect(
      readTelegramAccountHistory(client, peer),
    ).rejects.toMatchObject({ code: "TELEGRAM_HISTORY_PAGINATION_INVALID" });
  });

  it("rejects a different peer on a later page without returning the valid prefix", async () => {
    const { client, rpc } = transport([]);
    const foreign = message(8, "another peer's content");
    foreign.peerId = new Api.PeerUser({
      userId: readBigIntFromBuffer(Buffer.from([72])),
    });
    rpc.mockResolvedValueOnce(page([message(9)]));
    rpc.mockResolvedValueOnce(page([foreign]));
    await expect(
      readTelegramAccountHistory(client, peer),
    ).rejects.toMatchObject({
      code: "TELEGRAM_HISTORY_PEER_MISMATCH",
    });
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it("fails the complete read if a later provider page fails", async () => {
    const { client, rpc } = transport([]);
    rpc.mockResolvedValueOnce(page([message(9)]));
    rpc.mockRejectedValueOnce(new Error("provider connection lost"));
    await expect(
      readTelegramAccountHistory(client, peer),
    ).rejects.toMatchObject({ code: "TELEGRAM_HISTORY_READ_FAILED" });
  });

  it("honors only explicit caller limits and rejects invalid cursors before RPC", async () => {
    const { client, rpc } = transport(
      Array.from({ length: 205 }, (_, i) => message(205 - i)),
    );
    expect(
      (await readTelegramAccountHistory(client, peer, { limit: 103 })).map(
        (row) => row.id,
      ),
    ).toEqual(Array.from({ length: 103 }, (_, i) => 205 - i));
    rpc.mockClear();
    await expect(
      readTelegramAccountHistory(client, peer, { cursor: "unbound" }),
    ).rejects.toMatchObject({ code: "TELEGRAM_HISTORY_CURSOR_UNSUPPORTED" });
    await expect(
      readTelegramAccountHistory(client, peer, { limit: 0 }),
    ).rejects.toMatchObject({ code: "TELEGRAM_HISTORY_QUERY_INVALID" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("checks account admission between pages and before returning", async () => {
    const { client, requests } = transport([message(5)]);
    let checks = 0;
    await expect(
      readTelegramAccountHistory(client, peer, {}, async () => {
        if (++checks === 2) throw new Error("account revoked");
      }),
    ).rejects.toThrow("account revoked");
    expect(requests).toHaveLength(1);
  });
});
