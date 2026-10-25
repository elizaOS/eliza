/** Dependency-free route boundary shared by the host and shell history writer. */
export function isDeveloperWorkspaceRoute(
  location:
    | { hostname?: string; pathname?: string }
    | undefined = typeof window === "undefined" ? undefined : window.location,
): boolean {
  return Boolean(
    import.meta.env?.DEV &&
      location &&
      ["127.0.0.1", "localhost", "[::1]"].includes(location.hostname ?? "") &&
      /^\/dev2?\/?$/.test(location.pathname ?? ""),
  );
}

/** Keep shell path writers inside the current developer route, including agent view actions. */
export function developerShellUrl(
  url: string | URL | null | undefined,
): string | URL | null | undefined {
  if (!url || !isDeveloperWorkspaceRoute()) return url;
  const target = new URL(url, window.location.href);
  if (
    target.origin !== window.location.origin ||
    isDeveloperWorkspaceRoute(target)
  )
    return url;
  return `${window.location.pathname}${window.location.search}#${target.pathname}${target.search}${target.hash}`;
}
