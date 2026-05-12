import { type ReactNode, useCallback, useMemo } from "react";
import {
  useLocation,
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
  prefetch: (_href: string) => Promise<void>;
};

function isExternalHref(href: string): boolean {
  try {
    const url = new URL(href, window.location.origin);
    return url.origin !== window.location.origin;
  } catch {
    return false;
  }
}

function normalizeInternalHref(href: string): string {
  try {
    const url = new URL(href, window.location.origin);
    if (url.origin === window.location.origin) {
      return `${url.pathname}${url.search}${url.hash}`;
    }
  } catch {}
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
      prefetch: async () => {},
    }),
    [navigate],
  );
}

export function usePathname(): string {
  return useLocation().pathname;
}

export function useSearchParams(): URLSearchParams {
  const [searchParams] = useReactRouterSearchParams();
  return searchParams;
}

export function notFound(): never {
  throw new Error("notFound() is not supported in the SPA runtime");
}

export function redirect(href: string): never {
  window.location.assign(href);
  throw new Error(`redirected to ${href}`);
}

export function useSelectedLayoutSegment(): string | null {
  const pathname = usePathname();
  const segments = pathname.split("/").filter(Boolean);
  return segments.at(-1) ?? null;
}

export function useSelectedLayoutSegments(): string[] {
  const pathname = usePathname();
  return pathname.split("/").filter(Boolean);
}

export function useParams<T extends Record<string, string | string[]> = Record<string, string>>() {
  return useReactRouterParams() as T;
}

export function useServerInsertedHTML(_callback: () => ReactNode): void {}

export function useCallbackRouterPush(href: string, options?: NavigateOptions) {
  const router = useRouter();
  return useCallback(() => router.push(href, options), [href, options, router]);
}
