import { logger } from '@feed/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/useAuth';
import type {
  EligibilityApiResponse,
  EligibilityResponse,
  MintConfirmResponse,
  MintFlowState,
} from '@/types/nft';
import { apiUrl } from '@/utils/api-url';

const MINTING_STATES = new Set<MintFlowState>([
  'preparing',
  'minting',
  'confirming',
]);

interface UseNftMintResult {
  eligibility: EligibilityResponse | null;
  isCheckingEligibility: boolean;
  isMinting: boolean;
  flowState: MintFlowState;
  mintedNft: MintConfirmResponse['nft'] | null;
  error: string | null;
  checkEligibility: () => Promise<void>;
  startMint: () => Promise<void>;
  resetFlow: () => void;
}

export function useNftMint(): UseNftMintResult {
  const { authenticated, getAccessToken } = useAuth();

  const [eligibility, setEligibility] = useState<EligibilityResponse | null>(
    null
  );
  const [isCheckingEligibility, setIsCheckingEligibility] = useState(false);
  const [flowState, setFlowState] = useState<MintFlowState>('idle');
  const [mintedNft, setMintedNft] = useState<MintConfirmResponse['nft'] | null>(
    null
  );
  const [error, setError] = useState<string | null>(null);

  const checkEligibility = useCallback(
    async (signal?: AbortSignal) => {
      const notAuthenticated: EligibilityResponse = {
        eligible: false,
        status: 'not_authenticated',
        hasMinted: false,
      };

      if (!authenticated) {
        setEligibility(notAuthenticated);
        return;
      }

      setIsCheckingEligibility(true);
      setFlowState('checking_eligibility');
      setError(null);

      try {
        // In production we may rely on Privy's HttpOnly cookie auth. In that setup,
        // `getAccessToken()` can be unavailable/undefined in the browser, but the
        // cookie still authenticates same-origin requests.
        const token = await getAccessToken().catch(() => null);

        // Check if aborted before continuing
        if (signal?.aborted) return;

        const response = await fetch(apiUrl('/api/nft/eligibility'), {
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
          credentials: 'include',
          signal, // Pass abort signal to fetch
        });

        // Check if aborted before updating state
        if (signal?.aborted) return;

        if (response.status === 401) {
          setEligibility(notAuthenticated);
          setFlowState('idle');
          return;
        }

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          setError(errorData.error ?? 'Failed to check eligibility');
          setFlowState('error');
          return;
        }

        const json: EligibilityApiResponse = await response.json();
        const data: EligibilityResponse = json.data;

        // Check if aborted before updating state
        if (signal?.aborted) return;

        setEligibility(data);

        if (data.status === 'already_minted' && data.mintedNft) {
          // Note: eligibility endpoint only provides thumbnailUrl, not full resolution.
          // The thumbnailUrl is used as imageUrl here for display purposes.
          setMintedNft({
            tokenId: data.mintedNft.tokenId,
            name: data.mintedNft.name,
            imageUrl: data.mintedNft.thumbnailUrl,
            thumbnailUrl: data.mintedNft.thumbnailUrl,
            storyTitle: null,
          });
        }

        setFlowState(data.eligible ? 'eligible' : 'idle');
      } catch (err) {
        // Ignore abort errors - component unmounted
        if (err instanceof DOMException && err.name === 'AbortError') return;

        const message = err instanceof Error ? err.message : 'Network error';
        setError(message);
        setFlowState('error');
      } finally {
        // Only update if not aborted
        if (!signal?.aborted) {
          setIsCheckingEligibility(false);
        }
      }
    },
    [authenticated, getAccessToken]
  );

  const startMint = useCallback(async () => {
    const handleError = (message: string, errorId?: string) => {
      const uiMessage = errorId ? `${message} (Ref: ${errorId})` : message;
      setError(uiMessage);
      toast.error(uiMessage);
      setFlowState('error');
    };

    if (!authenticated) {
      toast.error('Please connect your wallet first');
      return;
    }

    if (!eligibility?.eligible || eligibility.hasMinted) {
      toast.error('You are not eligible to mint');
      return;
    }

    setFlowState('preparing');
    setError(null);

    try {
      setFlowState('minting');

      // Per Privy cookie best practices, always refresh the session before
      // triggering a privileged server-side action.
      //
      // This avoids relying on a potentially-missing/stale `privy-token` cookie
      // on the first request after the user returns to the app.
      let userJwt: string | null;
      try {
        userJwt = await getAccessToken();
      } catch {
        userJwt = null;
      }
      if (!userJwt) {
        handleError(
          'Your session has expired. Please sign in again and try minting.'
        );
        return;
      }

      const mintResponse = await fetch(apiUrl('/api/nft/mint/execute'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userJwt}`,
        },
        credentials: 'include',
      });

      const result = await mintResponse.json();

      if (result.status === 'error') {
        logger.error(
          '[NFT Mint Error]',
          {
            step: result.step,
            errorId: result.errorId,
            message: result.error,
            debug: result.debug,
          },
          'useNftMint'
        );
        handleError(result.error, result.errorId);
        return;
      }

      if (result.status === 'pending') {
        // Transaction submitted but not yet confirmed
        // Show a different toast and let user know they can check later
        toast.info(result.message, { duration: 10000 });
        setFlowState('eligible'); // Reset to eligible state so they can try again later
        return;
      }

      // Transaction confirmed - update state with minted NFT
      setMintedNft(result.nft);
      setFlowState('revealing');
      setEligibility((prev) =>
        prev
          ? {
              ...prev,
              hasMinted: true,
              status: 'already_minted',
              mintedNft: {
                tokenId: result.nft.tokenId,
                name: result.nft.name,
                thumbnailUrl: result.nft.thumbnailUrl ?? result.nft.imageUrl,
                txHash: result.txHash,
              },
            }
          : null
      );

      toast.success('NFT minted successfully!');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Transaction failed';
      handleError(message);
    }
  }, [authenticated, eligibility, getAccessToken]);

  const resetFlow = useCallback(() => {
    setFlowState(
      eligibility?.hasMinted
        ? 'complete'
        : eligibility?.eligible
          ? 'eligible'
          : 'idle'
    );
    setError(null);
  }, [eligibility?.hasMinted, eligibility?.eligible]);

  const checkEligibilityRef = useRef(checkEligibility);
  useEffect(() => {
    checkEligibilityRef.current = checkEligibility;
  }, [checkEligibility]);

  useEffect(() => {
    const abortController = new AbortController();

    if (authenticated) {
      checkEligibilityRef.current(abortController.signal);
    } else {
      setEligibility(null);
      setFlowState('idle');
    }

    return () => {
      abortController.abort();
    };
  }, [authenticated]);

  const isMinting = MINTING_STATES.has(flowState);

  return {
    eligibility,
    isCheckingEligibility,
    isMinting,
    flowState,
    mintedNft,
    error,
    checkEligibility,
    startMint,
    resetFlow,
  };
}
