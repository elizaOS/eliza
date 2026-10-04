/**
 * Mounts Stripe's Embedded Checkout for a given publishable key + client secret.
 * Lazily loads `https://js.stripe.com/v3/` once (deduped via a module-level
 * promise and a marker script tag), initializes the embedded checkout, and
 * mounts it into a container ref. Surfaces load/init failures inline and tears
 * the checkout down on unmount.
 */
import { useEffect, useRef, useState } from "react";

interface StripeEmbeddedCheckoutProps {
  publishableKey: string;
  clientSecret: string;
  className?: string;
}

interface StripeEmbeddedCheckoutInstance {
  mount: (selectorOrElement: string | HTMLElement) => void;
  unmount?: () => void;
  destroy?: () => void;
}

interface StripeInstance {
  initEmbeddedCheckout: (options: {
    fetchClientSecret: () => Promise<string>;
  }) => Promise<StripeEmbeddedCheckoutInstance>;
}

type StripeFactory = (publishableKey: string) => StripeInstance;

declare global {
  interface Window {
    Stripe?: StripeFactory;
  }
}

let stripeLoader: Promise<StripeFactory> | null = null;

async function loadStripeFactory(): Promise<StripeFactory> {
  if (typeof window === "undefined") {
    throw new Error("Stripe embedded checkout requires a browser environment.");
  }
  if (typeof window.Stripe === "function") {
    return window.Stripe;
  }
  if (stripeLoader) {
    return stripeLoader;
  }

  stripeLoader = new Promise<StripeFactory>((resolve, reject) => {
    // No active module-owned load and no global factory: a leftover marker may
    // already have fired its load/error event. Start a fresh, observable attempt.
    document.querySelector('script[data-eliza-stripe-loader="true"]')?.remove();
    const script = document.createElement("script");
    script.src = "https://js.stripe.com/v3/";
    script.async = true;
    script.dataset.elizaStripeLoader = "true";
    const cleanup = () => {
      script.onload = null;
      script.onerror = null;
    };
    script.onload = () => {
      cleanup();
      if (typeof window.Stripe === "function") {
        resolve(window.Stripe);
      } else {
        script.remove();
        reject(new Error("Stripe.js loaded without Stripe factory."));
      }
    };
    script.onerror = () => {
      cleanup();
      script.remove();
      reject(new Error("Failed to load Stripe.js."));
    };
    document.head.appendChild(script);
  }).catch((error: unknown) => {
    stripeLoader = null;
    throw error;
  });

  return stripeLoader;
}

export function StripeEmbeddedCheckout({
  publishableKey,
  clientSecret,
  className = "",
}: StripeEmbeddedCheckoutProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const checkoutRef = useRef<StripeEmbeddedCheckoutInstance | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    const setup = async () => {
      setLoading(true);
      setError(null);

      try {
        const stripeFactory = await loadStripeFactory();
        if (cancelled) return;
        const stripe = stripeFactory(publishableKey);
        const checkout = await stripe.initEmbeddedCheckout({
          fetchClientSecret: async () => clientSecret,
        });
        if (cancelled) {
          checkout.destroy?.();
          return;
        }
        checkoutRef.current = checkout;
        if (containerRef.current) {
          checkout.mount(containerRef.current);
        }
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error
              ? err.message
              : "Failed to load embedded checkout.",
          );
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void setup();

    return () => {
      cancelled = true;
      checkoutRef.current?.unmount?.();
      checkoutRef.current?.destroy?.();
      checkoutRef.current = null;
    };
  }, [clientSecret, publishableKey]);

  if (error) {
    return (
      <div className="rounded-sm border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
        {error}
      </div>
    );
  }

  return (
    <div className={className}>
      {loading ? (
        <div className="rounded-sm border border-border/50 bg-bg/40 px-4 py-6 text-sm text-muted">
          Loading secure checkout…
        </div>
      ) : null}
      <div ref={containerRef} className={loading ? "hidden" : "block"} />
    </div>
  );
}
