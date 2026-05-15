import { readFileSync } from "fs";
import { logger } from "./logger";

const REFRESH_INTERVAL_MS = 60_000;
const LABEL_SELECTOR = "eliza.ai/gateway-config=true";

const projectConfigs = new Map<string, Record<string, string>>();
let refreshTimer: Timer | null = null;

let k8sToken: string | null = null;
let k8sCaCert: string | null = null;
let k8sNamespace: string | null = null;

function getK8sToken(): string | null {
  if (k8sToken !== null) return k8sToken;
  try {
    k8sToken = readFileSync("/var/run/secrets/kubernetes.io/serviceaccount/token", "utf-8").trim();
  } catch {
    k8sToken = "";
  }
  return k8sToken || null;
}

function getK8sCaCert(): string | null {
  if (k8sCaCert !== null) return k8sCaCert;
  try {
    k8sCaCert = readFileSync("/var/run/secrets/kubernetes.io/serviceaccount/ca.crt", "utf-8");
  } catch {
    k8sCaCert = "";
  }
  return k8sCaCert || null;
}

function getK8sNamespace(): string {
  if (k8sNamespace !== null) return k8sNamespace;
  try {
    k8sNamespace = readFileSync(
      "/var/run/secrets/kubernetes.io/serviceaccount/namespace",
      "utf-8",
    ).trim();
  } catch {
    k8sNamespace = "default";
  }
  return k8sNamespace;
}

interface K8sSecretList {
  items: Array<{
    metadata?: {
      name?: string;
      labels?: Record<string, string>;
    };
    data?: Record<string, string>;
  }>;
}

async function refreshProjectConfigs(): Promise<void> {
  const token = getK8sToken();
  if (!token) return;

  const ns = getK8sNamespace();
  const url = `https://kubernetes.default.svc/api/v1/namespaces/${ns}/secrets?labelSelector=${encodeURIComponent(LABEL_SELECTOR)}`;

  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      tls: { ca: getK8sCaCert() ?? undefined },
    } as RequestInit);

    if (!res.ok) {
      logger.error("Failed to list project secrets", {
        status: res.status,
        body: await res.text(),
      });
      return;
    }

    const data = (await res.json()) as K8sSecretList;
    const updated = new Map<string, Record<string, string>>();

    for (const secret of data.items) {
      const project = secret.metadata?.labels?.["eliza.ai/project"];
      if (!project || !secret.data) continue;

      const config: Record<string, string> = {};
      for (const [key, value] of Object.entries(secret.data)) {
        config[key] = Buffer.from(value, "base64").toString();
      }
      updated.set(project, config);
    }

    projectConfigs.clear();
    for (const [k, v] of updated) {
      projectConfigs.set(k, v);
    }

    logger.info("Project configs refreshed", {
      projects: [...updated.keys()],
    });
  } catch (err) {
    logger.error("Failed to refresh project configs", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Read a config value for a project.
 * 1. K8s secrets (keys like TELEGRAM_BOT_TOKEN with label eliza.ai/project)
 * 2. Env var: project name uppercased with hyphens → underscores
 *    eliza-app → ELIZA_APP_*, soulmates → SOULMATES_*
 */
export function getProjectEnv(project: string, key: string): string {
  const config = projectConfigs.get(project);
  if (config?.[key]) return config[key];
  const prefix = project.toUpperCase().replace(/-/g, "_");
  return process.env[`${prefix}_${key}`] ?? "";
}

export async function initProjectConfig(): Promise<void> {
  await refreshProjectConfigs();
  refreshTimer = setInterval(refreshProjectConfigs, REFRESH_INTERVAL_MS);
}

export function shutdownProjectConfig(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}
