/**
 * Exercises required HTTP authority binding on real Node request objects. These
 * tests cover propagation and revocation, not the upstream grant decision.
 */
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { stringToUuid } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  bindRequiredHttpAccessContext,
  resolveHttpAccessContext,
  revokeRequiredHttpAccessContext,
} from "./http-access-context";

const actor = stringToUuid("required-http-actor");
const room = stringToUuid("required-http-room");

function request() {
  return new IncomingMessage(new Socket());
}

describe("required HTTP data authority", () => {
  it("preserves an explicit empty scope even for an owner", () => {
    const req = request();
    bindRequiredHttpAccessContext(req, {
      requesterEntityId: actor,
      role: "OWNER",
      isOwner: true,
      authorizedRoomIds: [],
    });
    expect(resolveHttpAccessContext(req)?.authorizedRoomIds).toEqual([]);
    expect(resolveHttpAccessContext(request())).toBeUndefined();
  });

  it("copies grants and accepts a current narrowed scope for the same actor", () => {
    const req = request();
    const rooms = [room];
    const context = { requesterEntityId: actor, authorizedRoomIds: rooms };
    bindRequiredHttpAccessContext(req, context);
    rooms.push(stringToUuid("not-granted"));
    expect(resolveHttpAccessContext(req)?.authorizedRoomIds).toEqual([room]);
    expect(Object.isFrozen(resolveHttpAccessContext(req))).toBe(true);
    expect(
      Object.isFrozen(resolveHttpAccessContext(req)?.authorizedRoomIds),
    ).toBe(true);
    bindRequiredHttpAccessContext(req, { ...context, authorizedRoomIds: [] });
    expect(resolveHttpAccessContext(req)?.authorizedRoomIds).toEqual([]);
  });

  it("never replaces a pinned actor or recovers revoked authority through fallback", () => {
    const req = request();
    bindRequiredHttpAccessContext(req, {
      requesterEntityId: actor,
      authorizedRoomIds: [room],
    });
    expect(() =>
      bindRequiredHttpAccessContext(req, {
        requesterEntityId: stringToUuid("different-actor"),
        authorizedRoomIds: [room],
      }),
    ).toThrowError(
      expect.objectContaining({ code: "HTTP_ACCESS_CONTEXT_INVALID" }),
    );
    expect(() => resolveHttpAccessContext(req)).toThrowError(
      expect.objectContaining({ code: "HTTP_ACCESS_CONTEXT_REVOKED" }),
    );
    expect(() =>
      bindRequiredHttpAccessContext(req, {
        requesterEntityId: actor,
        authorizedRoomIds: [room],
      }),
    ).toThrow();
  });

  it("makes explicit revocation sticky, including before the initial binding", () => {
    const req = request();
    revokeRequiredHttpAccessContext(req);
    expect(() => resolveHttpAccessContext(req)).toThrowError(
      expect.objectContaining({ code: "HTTP_ACCESS_CONTEXT_REVOKED" }),
    );
    expect(() =>
      bindRequiredHttpAccessContext(req, {
        requesterEntityId: actor,
        authorizedRoomIds: [],
      }),
    ).toThrow();
  });

  it("rejects missing and invalid room scope without leaving an unfiltered request", () => {
    for (const authorizedRoomIds of [undefined, ["invalid-room"]]) {
      const req = request();
      expect(() =>
        Reflect.apply(bindRequiredHttpAccessContext, undefined, [
          req,
          { requesterEntityId: actor, authorizedRoomIds },
        ]),
      ).toThrowError(
        expect.objectContaining({ code: "HTTP_ACCESS_CONTEXT_INVALID" }),
      );
      expect(() => resolveHttpAccessContext(req)).toThrowError(
        expect.objectContaining({ code: "HTTP_ACCESS_CONTEXT_REVOKED" }),
      );
    }
  });
});
