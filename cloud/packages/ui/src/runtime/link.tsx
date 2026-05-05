import { type AnchorHTMLAttributes, forwardRef, type ReactNode } from "react";
import { Link as RouterLink } from "react-router-dom";

type CloudLinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & {
  href: string;
  as?: string;
  replace?: boolean;
  scroll?: boolean;
  prefetch?: boolean | null;
  locale?: string | false;
  children?: ReactNode;
};

function isInternalHref(href: string): boolean {
  if (href.startsWith("/") && !href.startsWith("//")) return true;
  try {
    const url = new URL(href, window.location.origin);
    return url.origin === window.location.origin;
  } catch {
    return false;
  }
}

function toInternalPath(href: string): string {
  try {
    const url = new URL(href, window.location.origin);
    if (url.origin === window.location.origin) {
      return `${url.pathname}${url.search}${url.hash}`;
    }
  } catch {}
  return href;
}

const CloudLink = forwardRef<HTMLAnchorElement, CloudLinkProps>(function CloudLink(
  {
    href,
    as: _as,
    replace,
    scroll: _scroll,
    prefetch: _prefetch,
    locale: _locale,
    children,
    ...rest
  },
  ref,
) {
  if (!isInternalHref(href)) {
    return (
      <a ref={ref} href={href} {...rest}>
        {children}
      </a>
    );
  }

  return (
    <RouterLink ref={ref} to={toInternalPath(href)} replace={replace} {...rest}>
      {children}
    </RouterLink>
  );
});

export default CloudLink;
