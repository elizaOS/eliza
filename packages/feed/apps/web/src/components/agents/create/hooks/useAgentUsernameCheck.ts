import { logger } from '@feed/shared';
import { useCallback, useEffect, useState } from 'react';
import { apiUrl } from '@/utils/api-url';

export type UsernameStatus =
  | 'available'
  | 'taken'
  | 'checking'
  | 'error'
  | null;

interface UseAgentUsernameCheckResult {
  usernameStatus: UsernameStatus;
  usernameSuggestion: string | null;
  isCheckingUsername: boolean;
  checkUsername: (username: string) => void;
  retryCheck: () => void;
}

/**
 * Hook for checking agent username availability
 * Reuses the same endpoint as user onboarding since agents share the User table
 */
export function useAgentUsernameCheck(
  username: string,
  debounceMs = 500
): UseAgentUsernameCheckResult {
  const [usernameStatus, setUsernameStatus] = useState<UsernameStatus>(null);
  const [usernameSuggestion, setUsernameSuggestion] = useState<string | null>(
    null
  );
  const [isCheckingUsername, setIsCheckingUsername] = useState(false);

  const checkUsername = useCallback(async (usernameToCheck: string) => {
    const trimmed = usernameToCheck.trim().toLowerCase();

    if (!trimmed || trimmed.length < 3) {
      setUsernameStatus(null);
      setUsernameSuggestion(null);
      return;
    }

    // Note: maxLength={20} on the input prevents usernames > 20 chars
    // The API also enforces a 20-char limit

    setIsCheckingUsername(true);
    setUsernameStatus('checking');

    try {
      const response = await fetch(
        apiUrl(
          `/api/onboarding/check-username?username=${encodeURIComponent(trimmed)}`
        )
      );

      if (response.ok) {
        const result = await response.json();
        setUsernameStatus(result.available ? 'available' : 'taken');
        setUsernameSuggestion(
          result.available ? null : result.suggestion || null
        );
      } else {
        setUsernameStatus('error');
        setUsernameSuggestion(null);
      }
    } catch (error) {
      logger.error(
        'Username check failed',
        error instanceof Error ? error : { error },
        'useAgentUsernameCheck'
      );
      setUsernameStatus('error');
      setUsernameSuggestion(null);
    } finally {
      setIsCheckingUsername(false);
    }
  }, []);

  // Retry the username check
  const retryCheck = useCallback(() => {
    const trimmed = username.trim().toLowerCase();
    if (trimmed && trimmed.length >= 3) {
      void checkUsername(trimmed);
    }
  }, [username, checkUsername]);

  // Debounced effect for automatic checking
  useEffect(() => {
    const trimmed = username.trim().toLowerCase();

    if (!trimmed || trimmed.length < 3) {
      setUsernameStatus(null);
      setUsernameSuggestion(null);
      return;
    }

    const timeoutId = setTimeout(() => {
      void checkUsername(trimmed);
    }, debounceMs);

    return () => clearTimeout(timeoutId);
  }, [username, debounceMs, checkUsername]);

  return {
    usernameStatus,
    usernameSuggestion,
    isCheckingUsername,
    checkUsername,
    retryCheck,
  };
}
