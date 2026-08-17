/** Proves the in-isolate Personal Shared auth capability is identity-bound and one-shot. */

import { expect, test } from "bun:test";
import {
  consumePreverifiedPersonalSharedRequest,
  markPreverifiedPersonalSharedRequest,
} from "./preverified-auth";

test("consumes a preverified request exactly once", () => {
  const request = new Request("https://personal-shared.internal/");
  const lookalike = new Request(request.url);
  const auth = { podName: "gateway-1", service: "discord-gateway" };

  markPreverifiedPersonalSharedRequest(request, auth);

  expect(consumePreverifiedPersonalSharedRequest(lookalike)).toBeUndefined();
  expect(consumePreverifiedPersonalSharedRequest(request)).toEqual(auth);
  expect(consumePreverifiedPersonalSharedRequest(request)).toBeUndefined();
});

test("rejects two identities claiming the same request", () => {
  const request = new Request("https://personal-shared.internal/");
  markPreverifiedPersonalSharedRequest(request, {
    podName: "gateway-1",
    service: "discord-gateway",
  });

  expect(() =>
    markPreverifiedPersonalSharedRequest(request, {
      podName: "gateway-2",
      service: "webhook-gateway",
    }),
  ).toThrow("already preverified");

  consumePreverifiedPersonalSharedRequest(request);
});
