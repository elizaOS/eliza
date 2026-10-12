// @vitest-environment jsdom
/**
 * Regression guard for the #18184 opaque-rejection contract in the browser
 * relay: the Cloud pair exchange collapses every rejection cause behind
 * 401/403/410, so the rendered copy must not assert one specific cause
 * (it previously claimed every such failure was an expired link — including
 * a non-loopback-origin 403 and a native cloud_auth_required 401).
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { CloudPairExchangeError, CloudPairRelay } from "../CloudPairRelay";

afterEach(cleanup);

async function renderFailureTitle(status: number): Promise<string> {
  cleanup();
  render(
    <CloudPairRelay
      token="test-token"
      exchangeFn={() =>
        Promise.reject(
          new CloudPairExchangeError("pairing rejected", status),
        )
      }
      persistFn={() => {}}
      onPaired={() => {}}
    />,
  );
  const heading = await screen.findByRole("heading", { level: 1 });
  return heading.textContent ?? "";
}

it("renders neutral copy for the opaque 401/403/410 rejections", async () => {
  for (const status of [401, 403, 410]) {
    await expect(renderFailureTitle(status)).resolves.toBe(
      "Sign-in link could not be verified",
    );
  }
});

it("keeps the rate-limit and generic failure copy unchanged", async () => {
  await expect(renderFailureTitle(429)).resolves.toBe(
    "Too many sign-in attempts",
  );
  await expect(renderFailureTitle(500)).resolves.toBe("Could not sign in");
});
