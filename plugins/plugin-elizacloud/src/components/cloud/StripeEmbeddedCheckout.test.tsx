// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { StripeEmbeddedCheckout } from "./StripeEmbeddedCheckout";

afterEach(() => {
  cleanup();
  delete window.Stripe;
  document
    .querySelectorAll('script[data-eliza-stripe-loader="true"]')
    .forEach((script) => {
      script.remove();
    });
});
test("a failed script can retry on remount and cleans up its checkout", async () => {
  const first = render(
    <StripeEmbeddedCheckout publishableKey="test" clientSecret="first" />,
  );
  const failed = document.querySelector(
    'script[data-eliza-stripe-loader="true"]',
  );
  if (!failed) throw new Error("Missing Stripe script");
  await act(async () => {
    failed.dispatchEvent(new Event("error"));
  });
  expect(screen.getByText("Failed to load Stripe.js.")).toBeTruthy();
  expect(failed.isConnected).toBe(false);
  first.unmount();
  const mount = vi.fn();
  const destroy = vi.fn();
  const second = render(
    <StripeEmbeddedCheckout publishableKey="test" clientSecret="second" />,
  );
  const next = document.querySelector(
    'script[data-eliza-stripe-loader="true"]',
  );
  if (!next) throw new Error("Missing retry script");
  expect(next).not.toBe(failed);
  window.Stripe = () => ({
    initEmbeddedCheckout: async ({ fetchClientSecret }) => {
      expect(await fetchClientSecret()).toBe("second");
      return { mount, destroy };
    },
  });
  await act(async () => {
    next.dispatchEvent(new Event("load"));
  });
  await waitFor(() => expect(mount).toHaveBeenCalledTimes(1));
  second.unmount();
  expect(destroy).toHaveBeenCalledTimes(1);
});
test("destroys a checkout that completes after unmount without mounting it", async () => {
  let complete!: (instance: { mount: () => void; destroy: () => void }) => void;
  const mount = vi.fn();
  const destroy = vi.fn();
  window.Stripe = () => ({
    initEmbeddedCheckout: () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  });
  const view = render(
    <StripeEmbeddedCheckout publishableKey="test" clientSecret="secret" />,
  );
  await act(async () => {});
  view.unmount();
  await act(async () => {
    complete({ mount, destroy });
  });
  expect(mount).not.toHaveBeenCalled();
  expect(destroy).toHaveBeenCalledTimes(1);
});
