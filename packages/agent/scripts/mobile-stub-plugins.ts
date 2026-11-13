/**
 * Host-selected mobile stubs. A host that never loads a plugin can name it, or a
 * heavy package only that plugin uses, in `ELIZA_MOBILE_STUB_PLUGINS`. The mobile
 * build then resolves the package and its subpaths to the `null-plugin` stub, so
 * its code is not in the bundle. Named imports from a stub are `undefined` and
 * calls fail; the build's load smoke catches a stub that module init needs.
 */
export const MOBILE_STUB_PLUGINS_ENV = "ELIZA_MOBILE_STUB_PLUGINS";

const BARE_SPECIFIER =
  /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9._@-]+)*$/i;

/** Parses a comma- or whitespace-separated list of bare package specifiers. */
export function parseMobileStubPlugins(value: string | undefined): string[] {
  const names = new Set<string>();
  for (const name of (value ?? "").split(/[\s,]+/)) {
    if (!name) continue;
    if (
      !BARE_SPECIFIER.test(name) ||
      name.split("/").some((part) => part === "." || part === "..")
    )
      throw new Error(
        `${MOBILE_STUB_PLUGINS_ENV}: "${name}" is not a bare package specifier`,
      );
    names.add(name);
  }
  return [...names].sort();
}

/** Returns `stubs` with every host name mapped to `stubPath`. Host names win. */
export function mergeMobileStubPlugins(
  stubs: Readonly<Record<string, string>>,
  names: readonly string[],
  stubPath: string,
): Record<string, string> {
  return {
    ...stubs,
    ...Object.fromEntries(names.map((name) => [name, stubPath])),
  };
}

/** The longest alias that is `specifier` or a path prefix of it. */
export function matchStubAlias(
  specifier: string,
  aliases: readonly string[],
): string | null {
  let best: string | null = null;
  for (const name of aliases)
    if (
      (specifier === name || specifier.startsWith(`${name}/`)) &&
      (best === null || name.length > best.length)
    )
      best = name;
  return best;
}

type ResolveBuild = {
  onResolve(
    options: { filter: RegExp },
    callback: (args: {
      path: string;
    }) => { path: string; namespace: string } | undefined,
  ): void;
};

/**
 * Resolves each of `names` and its subpaths to its longest alias in `aliases`.
 * An empty `names` installs nothing.
 */
export function addStubAliasResolver(
  build: ResolveBuild,
  aliases: Readonly<Record<string, string>>,
  names: readonly string[],
): void {
  if (names.length === 0) return;
  const aliasNames = Object.keys(aliases);
  const escaped = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const filter = new RegExp(`^(?:${escaped.join("|")})(?:/.*)?$`);
  build.onResolve({ filter }, (args) => {
    const best = matchStubAlias(args.path, aliasNames);
    if (best === null) return undefined;
    return { path: aliases[best], namespace: "file" };
  });
}
