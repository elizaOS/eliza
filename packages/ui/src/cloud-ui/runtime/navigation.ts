/**
 * Runtime navigation shim for cloud-ui backed by react-router (location, navigate, params).
 */
import { useMemo } from "react";
import {
  useNavigate,
  useParams as useReactRouterParams,
  useSearchParams as useReactRouterSearchParams,
} from "react-router-dom";

type NavigateOptions = {
  scroll?: boolean;
};

type ClientRouter = {
  push: (href: string, options?: NavigateOptions) => void;
  replace: (href: string, options?: NavigateOptions) => void;
  refresh: () => void;
  back: () => void;
  forward: () => void;
};

function isExternalHref(href: string): boolean {
  try {
    const url = new URL(href, window.location.origin);
    return url.origin !== window.location.origin;
  } catch {
    // error-policy:J3 unparseable href cannot be proven external — keep it on
    // the in-app router, which rejects unroutable paths itself.
    return false;
  }
}

function normalizeInternalHref(href: string): string {
  try {
    const url = new URL(href, window.location.origin);
    if (url.origin === window.location.origin) {
      return `${url.pathname}${url.search}${url.hash}`;
    }
  } catch {
    // error-policy:J3 unparseable href passes through unchanged for the
    // router to reject; normalization is best-effort sugar.
  }
  return href;
}

function scrollToTop(options: NavigateOptions | undefined) {
  if (options?.scroll === false) return;
  window.requestAnimationFrame(() => {
    window.scrollTo({ top: 0, left: 0 });
  });
}

export function useRouter(): ClientRouter {
  const navigate = useNavigate();

  return useMemo(
    () => ({
      push: (href, options) => {
        if (isExternalHref(href)) {
          window.location.assign(href);
          return;
        }
        navigate(normalizeInternalHref(href));
        scrollToTop(options);
      },
      replace: (href, options) => {
        if (isExternalHref(href)) {
          window.location.replace(href);
          return;
        }
        navigate(normalizeInternalHref(href), { replace: true });
        scrollToTop(options);
      },
      refresh: () => {
        window.location.reload();
      },
      back: () => {
        window.history.back();
      },
      forward: () => {
        window.history.forward();
      },
    }),
    [navigate],
  );
}

export function useSearchParams(): URLSearchParams {
  const [searchParams] = useReactRouterSearchParams();
  return searchParams;
}

export function redirect(href: string): never {
  window.location.assign(href);
  throw new Error(`redirected to ${href}`);
}

export function useParams<
  T extends Record<string, string | string[]> = Record<string, string>,
>() {
  return useReactRouterParams() as T;
}
