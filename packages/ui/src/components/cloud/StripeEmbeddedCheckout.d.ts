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
export declare function StripeEmbeddedCheckout({
  publishableKey,
  clientSecret,
  className,
}: StripeEmbeddedCheckoutProps): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=StripeEmbeddedCheckout.d.ts.map
