'use client';

import { cn, logger } from '@feed/shared';

import {
  AlertCircle,
  CheckCircle2,
  CreditCard,
  DollarSign,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Skeleton } from '@/components/shared/Skeleton';
import { useAuth } from '@/hooks/useAuth';
import { isStripeEnabled } from '@/lib/stripe';

/**
 * Trading balance purchase modal — Stripe card payment only.
 *
 * Users enter a USD amount and are redirected to Stripe Checkout.
 * The trading balance is credited via webhook after successful payment.
 */
interface BuyPointsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: () => void;
}

type PaymentStep = 'input' | 'redirecting' | 'error';

/** Abort requests that take longer than this. */
const API_FETCH_TIMEOUT_MS = 45_000;
const API_FETCH_TIMEOUT_MESSAGE =
  'Request timed out. Check your connection and try again in a moment.';

function isAbortLikeError(error: unknown): error is Error {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || error.name === 'TimeoutError')
  );
}

export function BuyPointsModal({
  isOpen,
  onClose,
  onSuccess: _onSuccess,
}: BuyPointsModalProps) {
  const { user } = useAuth();
  const { getAccessToken } = useAuth();

  const [amountUSD, setAmountUSD] = useState('10');
  const [step, setStep] = useState<PaymentStep>('input');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const stripeAvailable = isStripeEnabled();
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // Reset state when modal closes
  useEffect(() => {
    if (!isOpen) {
      const timeoutId = setTimeout(() => {
        if (isMountedRef.current) {
          setAmountUSD('10');
          setStep('input');
          setLoading(false);
          setError(null);
        }
      }, 300);
      return () => clearTimeout(timeoutId);
    }
    return undefined;
  }, [isOpen]);

  // Handle escape key and body scroll lock
  useEffect(() => {
    if (!isOpen) {
      document.body.style.overflow = '';
      return;
    }

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !loading && step === 'input') {
        onClose();
      }
    };

    document.addEventListener('keydown', handleEscape);
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', handleEscape);
      document.body.style.overflow = '';
    };
  }, [isOpen, onClose, loading, step]);

  useEffect(() => {
    return () => {
      document.body.style.overflow = '';
    };
  }, []);

  if (!isOpen) return null;

  const amountNum = Number.parseFloat(amountUSD) || 0;
  const balanceUnits = Math.floor(amountNum * 100);

  const handleClose = () => {
    if (loading || step === 'redirecting') return;
    onClose();
  };

  const handleStripeCheckout = async () => {
    if (!user) {
      toast.error('Please sign in to continue');
      return;
    }

    if (amountNum < 1) {
      toast.error('Minimum purchase is $1');
      return;
    }

    if (amountNum > 1000) {
      toast.error('Maximum purchase is $1000');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const token = await getAccessToken();

      if (!token) {
        logger.error('Authentication required', undefined, 'BuyPointsModal');
        setError('Authentication required');
        setStep('error');
        toast.error('Please sign in to continue');
        return;
      }

      const response = await fetch('/api/stripe/checkout/session', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ amountUSD: amountNum }),
        signal: AbortSignal.timeout(API_FETCH_TIMEOUT_MS),
      });

      const data = await response.json();

      if (!response.ok || !data.success) {
        const errorMessage = data.error || 'Failed to create checkout session';
        logger.error(
          'Failed to create Stripe checkout',
          { error: errorMessage },
          'BuyPointsModal'
        );
        setError(errorMessage);
        setStep('error');
        toast.error('Failed to start checkout');
        return;
      }

      setStep('redirecting');
      window.location.href = data.url;
    } catch (err) {
      if (isAbortLikeError(err)) {
        logger.error('Stripe checkout timed out', undefined, 'BuyPointsModal');
        setError(API_FETCH_TIMEOUT_MESSAGE);
        setStep('error');
        toast.error(API_FETCH_TIMEOUT_MESSAGE);
        return;
      }
      const errorMessage = err instanceof Error ? err.message : 'Network error';
      logger.error(
        'Stripe checkout failed',
        { error: errorMessage },
        'BuyPointsModal'
      );
      setError(errorMessage);
      setStep('error');
      toast.error('Failed to connect to payment server');
    } finally {
      if (isMountedRef.current) {
        setLoading(false);
      }
    }
  };

  const renderContent = () => {
    switch (step) {
      case 'input':
        return (
          <div className="flex h-full flex-col">
            <div className="flex-1 space-y-5">
              {/* Amount Input + Quick Buttons */}
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <label className="font-medium text-foreground text-sm">
                    Funding Amount (USD)
                  </label>
                  <span className="text-muted-foreground text-xs">
                    Min: $1 • Max: $1,000
                  </span>
                </div>
                <div className="relative">
                  <DollarSign className="absolute top-1/2 left-3 h-5 w-5 -translate-y-1/2 text-muted-foreground" />
                  <input
                    data-testid="points-amount-input"
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    value={amountUSD}
                    onChange={(e) => {
                      const sanitized = e.target.value.replace(/[^0-9]/g, '');
                      const noLeadingZeros = sanitized.replace(/^0+/, '') || '';
                      const num = parseInt(noLeadingZeros, 10);
                      if (noLeadingZeros === '' || isNaN(num)) {
                        setAmountUSD('');
                      } else if (num > 1000) {
                        setAmountUSD('1000');
                      } else {
                        setAmountUSD(noLeadingZeros);
                      }
                    }}
                    className="w-full rounded-lg border-2 border-border bg-background py-3 pr-4 pl-10 font-medium text-lg transition-colors focus:border-primary focus:outline-none"
                    placeholder="10"
                    disabled={loading}
                  />
                </div>
                {/* Quick Amount Buttons */}
                <div className="mt-1 grid grid-cols-4 gap-2">
                  {[10, 25, 50, 100].map((amt) => (
                    <button
                      key={amt}
                      onClick={() => setAmountUSD(amt.toString())}
                      className={cn(
                        'rounded-lg border-2 py-2.5 font-medium transition-all',
                        amountNum === amt
                          ? 'border-primary bg-primary text-primary-foreground'
                          : 'border-border hover:border-muted-foreground/50'
                      )}
                      disabled={loading}
                    >
                      ${amt}
                    </button>
                  ))}
                </div>
              </div>

              {/* Trading balance funding preview */}
              <div className="rounded-lg bg-blue-500/10 p-4 text-center">
                <p className="mb-1 text-muted-foreground text-xs uppercase tracking-wide">
                  You'll receive
                </p>
                <div className="flex items-center justify-center gap-2">
                  <span
                    data-testid="balance-units-display"
                    className="font-bold text-3xl text-foreground"
                  >
                    {balanceUnits.toLocaleString()}
                  </span>
                  <span className="font-medium text-lg text-muted-foreground">
                    units
                  </span>
                </div>
                <p className="mt-3 text-muted-foreground text-xs">
                  100 balance units = $1 USD
                </p>
              </div>

              {/* No Stripe warning */}
              {!stripeAvailable && (
                <div className="flex items-start gap-3 rounded-lg bg-red-500/10 p-3">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-500" />
                  <div className="text-xs">
                    <p className="font-medium text-red-600 dark:text-red-400">
                      Card payments unavailable
                    </p>
                    <p className="mt-0.5 text-red-600/80 dark:text-red-400/80">
                      Card payments are not configured. Please contact support.
                    </p>
                  </div>
                </div>
              )}

              {/* Info notices */}
              <div className="space-y-2 text-muted-foreground text-xs">
                <div>
                  <p>Trading balance is non-transferable.</p>
                  <p>Balance units can be used for trading on Feed.</p>
                </div>
                <p className="flex items-start gap-2">
                  <CreditCard className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>
                    You'll be redirected to Stripe for secure checkout.
                  </span>
                </p>
              </div>
            </div>

            {/* Action Buttons */}
            <div className="mt-6 flex gap-3 border-border pt-4 md:border-t">
              <button
                onClick={handleClose}
                className="flex-1 rounded-lg border-2 border-border py-3 font-medium transition-colors hover:bg-muted"
                disabled={loading}
              >
                Cancel
              </button>
              <button
                data-testid="buy-points-submit-button"
                onClick={handleStripeCheckout}
                disabled={
                  loading ||
                  amountNum < 1 ||
                  amountNum > 1000 ||
                  !user ||
                  !stripeAvailable
                }
                className={cn(
                  'flex flex-1 items-center justify-center gap-2 rounded-lg py-3 font-medium transition-all',
                  'bg-primary text-primary-foreground hover:bg-primary/90',
                  'disabled:cursor-not-allowed disabled:opacity-50'
                )}
              >
                {loading ? 'Processing...' : 'Fund Balance'}
              </button>
            </div>
          </div>
        );

      case 'redirecting':
        return (
          <div className="flex flex-col items-center justify-center py-12">
            <div className="mb-6">
              <Skeleton className="h-16 w-16 rounded-full" />
            </div>
            <h3 className="mb-2 font-semibold text-foreground text-lg">
              Redirecting to Stripe...
            </h3>
            <p className="mb-6 text-center text-muted-foreground text-sm">
              You will be redirected to Stripe to complete your payment
              securely.
            </p>
          </div>
        );

      case 'error':
        return (
          <div
            data-testid="payment-error"
            className="flex flex-col items-center justify-center py-12"
          >
            <div className="mb-6 flex h-16 w-16 items-center justify-center rounded-full bg-red-500/10">
              <AlertCircle className="h-10 w-10 text-red-500" />
            </div>
            <h3 className="mb-2 font-semibold text-foreground text-lg">
              Payment Failed
            </h3>
            <p
              data-testid="payment-error-message"
              className="mb-8 text-center text-muted-foreground text-sm"
            >
              {error || 'An error occurred during payment'}
            </p>
            <div className="flex w-full gap-3">
              <button
                onClick={handleClose}
                className="flex-1 rounded-lg border-2 border-border py-3 font-medium transition-colors hover:bg-muted"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  setStep('input');
                  setError(null);
                }}
                className="flex-1 rounded-lg bg-primary py-3 font-medium text-primary-foreground transition-colors hover:bg-primary/90"
              >
                Try Again
              </button>
            </div>
          </div>
        );
    }
  };

  // Keep CheckCircle2 import used — for future success state if Stripe return URL flow is added
  void CheckCircle2;

  return (
    <div
      data-testid="buy-points-modal-overlay"
      className="fixed inset-0 z-[110] flex items-center justify-center bg-black/60 p-0 backdrop-blur-sm md:p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          handleClose();
        }
      }}
    >
      <div
        data-testid="buy-points-modal"
        className="relative flex h-full w-full flex-col bg-background md:h-auto md:max-h-[90vh] md:w-auto md:min-w-[480px] md:max-w-lg md:rounded-lg md:border md:border-border"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="shrink-0 border-border border-b px-4 py-3 sm:px-6 sm:py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <h2 className="font-bold text-lg">Fund Trading Balance</h2>
            </div>
            <button
              onClick={handleClose}
              className="rounded-full p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              disabled={loading || step === 'redirecting'}
              aria-label="Close"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto overscroll-contain px-4 py-4 sm:px-6 sm:py-6">
          {renderContent()}
        </div>
      </div>
    </div>
  );
}
