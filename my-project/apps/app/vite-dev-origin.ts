export interface ViteHmrConfig {
  host?: string;
  port: number;
  clientPort?: number;
  protocol?: "ws" | "wss";
}

export interface ViteDevServerRuntime {
  origin?: string;
  hmr: ViteHmrConfig;
}

function envFlagEnabled(
  env: Record<string, string | undefined>,
  keys: string[],
): boolean {
  return keys.some((key) => {
    const normalized = env[key]?.trim().toLowerCase();
    return normalized === "1" || normalized === "true";
  });
}

function parseHttpOrigin(raw: string | undefined): URL | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function resolveOriginPort(origin: URL, fallbackPort: number): number {
  if (origin.port) {
    const parsedPort = Number.parseInt(origin.port, 10);
    if (Number.isFinite(parsedPort) && parsedPort > 0) {
      return parsedPort;
    }
  }

  if (origin.protocol === "https:") {
    return 443;
  }

  if (origin.protocol === "http:") {
    return 80;
  }

  return fallbackPort;
}

function withPublicClientPort(
  hmr: ViteHmrConfig,
  publicPort: number,
): ViteHmrConfig {
  if (publicPort === hmr.port) {
    return hmr;
  }

  return {
    ...hmr,
    clientPort: publicPort,
  };
}

/**
 * Resolve the Vite dev-server origin/HMR runtime configuration from env.
 *
 * `brandedPrefix` is the per-app env prefix (e.g. `ELIZA`, `MYAPP`). When
 * unset, only the generic `ELIZA_*` env vars are consulted.
 */
export function resolveViteDevServerRuntime(
  env: Record<string, string | undefined>,
  uiPort: number,
  brandedPrefix = "ELIZA",
): ViteDevServerRuntime {
  const branded = (suffix: string) => `${brandedPrefix}_${suffix}`;
  const explicitOrigin = parseHttpOrigin(
    env[branded("VITE_ORIGIN")] ?? env.ELIZA_VITE_ORIGIN,
  );
  const explicitHmrHost = (
    env[branded("HMR_HOST")] ??
    env.ELIZA_HMR_HOST ??
    ""
  ).trim();

  if (explicitOrigin) {
    return {
      origin: explicitOrigin.origin,
      hmr: withPublicClientPort(
        {
          host: explicitHmrHost || explicitOrigin.hostname,
          port: uiPort,
          protocol: explicitOrigin.protocol === "https:" ? "wss" : "ws",
        },
        resolveOriginPort(explicitOrigin, uiPort),
      ),
    };
  }

  if (
    envFlagEnabled(env, [
      branded("VITE_LOOPBACK_ORIGIN"),
      "ELIZA_VITE_LOOPBACK_ORIGIN",
    ])
  ) {
    return {
      origin: `http://127.0.0.1:${uiPort}`,
      hmr: {
        host: explicitHmrHost || "127.0.0.1",
        port: uiPort,
        protocol: "ws",
      },
    };
  }

  return {
    hmr: {
      ...(explicitHmrHost ? { host: explicitHmrHost } : {}),
      port: uiPort,
    },
  };
}
