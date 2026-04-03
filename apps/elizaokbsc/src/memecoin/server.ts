import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { URL } from "node:url";
import type { AgentRuntime } from "@elizaos/core";
import { getDiscoveryConfig } from "./config";
import { executeDistributionLane } from "./distribution-execution";
import { buildDistributionPlan } from "./distribution";
import { persistDistributionExecutionState } from "./persist";
import { getLatestSnapshot } from "./store";
import type { CandidateDetail, DashboardSnapshot, PortfolioPositionDetail } from "./types";

const ELIZAOK_LOGO_ASSET_PATHS = [
  "/Users/baoger/.cursor/projects/Users-baoger-polymarket-agent/assets/Untitled-20260401-191459-3424-92579f8c-32e9-492a-b56b-cdefdd4c6858.png",
  "/Users/baoger/.cursor/projects/Users-baoger-polymarket-agent/assets/Untitled-20260401-191459-3424-6b4ab8e2-1062-4421-a562-c21be524f0e5.png",
  "/Users/baoger/.cursor/projects/Users-baoger-polymarket-agent/assets/Untitled-20260401-191459-3424-d9d36740-5e03-42ff-93d1-d93cb2e471ef.png",
];

const ELIZAOK_BANNER_ASSET_PATHS = [
  "/Users/baoger/.cursor/projects/Users-baoger-polymarket-agent/assets/1500x500-8f387aee-fe62-46d8-8506-4aa8e185618b.png",
];

async function loadSnapshotFromDisk(reportsDir: string): Promise<DashboardSnapshot | null> {
  const snapshotPath = path.join(process.cwd(), reportsDir, "latest.json");
  try {
    const content = await readFile(snapshotPath, "utf8");
    return JSON.parse(content) as DashboardSnapshot;
  } catch {
    return null;
  }
}

async function loadCandidateHistoryFromDisk(reportsDir: string): Promise<CandidateDetail[]> {
  const historyPath = path.join(process.cwd(), reportsDir, "candidate-history.json");
  try {
    const content = await readFile(historyPath, "utf8");
    return JSON.parse(content) as CandidateDetail[];
  } catch {
    return [];
  }
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload, null, 2));
}

function sendBinary(
  res: ServerResponse,
  statusCode: number,
  contentType: string,
  payload: Buffer | Uint8Array
): void {
  res.writeHead(statusCode, { "content-type": contentType });
  res.end(payload);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function recommendationTone(value: string): string {
  if (value.includes("buy") || value.includes("candidate")) return "tone-hot";
  if (value.includes("watch") || value.includes("priority")) return "tone-warm";
  return "tone-cool";
}

function formatUsd(value: number): string {
  return `$${Math.round(value).toLocaleString()}`;
}

function formatBnb(value: number): string {
  return `${value.toFixed(4)} BNB`;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function shortAddress(value: string): string {
  if (value.length < 14) return value;
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function candidateHref(tokenAddress: string): string {
  return `/candidate?token=${encodeURIComponent(tokenAddress)}`;
}

function portfolioHref(tokenAddress: string): string {
  return `/api/elizaok/portfolio/positions?token=${encodeURIComponent(tokenAddress)}`;
}

function gooCandidateHref(agentId: string): string {
  return `/goo-candidate?agent=${encodeURIComponent(agentId)}`;
}

function formatSeconds(value: number | null): string {
  if (value === null) return "n/a";
  if (value < 60) return `${value}s`;
  if (value < 3_600) return `${Math.round(value / 60)}m`;
  if (value < 86_400) return `${Math.round(value / 3_600)}h`;
  return `${Math.round(value / 86_400)}d`;
}

function buildGooReadiness(config: ReturnType<typeof getDiscoveryConfig>) {
  const checklist = [
    {
      label: "Module enabled",
      done: config.goo.enabled,
      detail: config.goo.enabled ? "Goo scan loop is enabled." : "Enable ELIZAOK_GOO_SCAN_ENABLED.",
    },
    {
      label: "RPC configured",
      done: Boolean(config.goo.rpcUrl),
      detail: config.goo.rpcUrl ? "RPC endpoint is configured." : "Add ELIZAOK_GOO_RPC_URL.",
    },
    {
      label: "Registry configured",
      done: Boolean(config.goo.registryAddress),
      detail: config.goo.registryAddress
        ? "Registry address is configured."
        : "Add ELIZAOK_GOO_REGISTRY_ADDRESS.",
    },
  ];
  const score = checklist.filter((item) => item.done).length;

  return {
    checklist,
    score,
    total: checklist.length,
    configured: score === checklist.length,
    nextAction:
      score === checklist.length
        ? "Live Goo scanning is ready. The operator layer can now be judged on candidate quality."
        : checklist.find((item) => !item.done)?.detail || "Complete remaining Goo configuration checks.",
  };
}

function buildGooCandidateDetail(
  candidate: DashboardSnapshot["topGooCandidates"][number],
  config: ReturnType<typeof getDiscoveryConfig>
) {
  const readiness = buildGooReadiness(config);
  const treasuryStressGapBnb = Math.max(0, candidate.starvingThresholdBnb - candidate.treasuryBnb);
  const urgency =
    candidate.status === "DYING"
      ? "critical"
      : candidate.status === "STARVING"
        ? "high"
        : candidate.secondsUntilPulseTimeout !== null && candidate.secondsUntilPulseTimeout < 3_600
          ? "high"
          : candidate.recommendation === "priority_due_diligence"
            ? "medium"
            : "low";
  const operatorAction =
    candidate.recommendation === "cto_candidate"
      ? "Prepare claimCTO parameters, capital guardrails, and post-acquisition genome fusion plan."
      : candidate.recommendation === "priority_due_diligence"
        ? "Run full due diligence on skill overlap, treasury ROI, and rescue timing before any CTO attempt."
        : candidate.recommendation === "monitor"
          ? "Keep the agent in the operator queue and wait for stronger distress or clearer synergy."
          : "Ignore for now and focus operator attention on stronger turnaround targets.";
  const acquisitionFit =
    candidate.minimumCtoBnb <= 0.2
      ? "Low-friction experimental CTO size."
      : candidate.minimumCtoBnb <= 1
        ? "Manageable CTO size with caution."
        : "High CTO floor for MVP treasury deployment.";

  return {
    candidate,
    readiness,
    urgency,
    treasuryStressGapBnb,
    operatorAction,
    acquisitionFit,
    pulseWindowLabel: formatSeconds(candidate.secondsUntilPulseTimeout),
  };
}

function buildPortfolioPositionDetail(
  snapshot: DashboardSnapshot | null,
  tokenAddress: string
): PortfolioPositionDetail {
  const allPositions = [
    ...(snapshot?.portfolioLifecycle.activePositions ?? []),
    ...(snapshot?.portfolioLifecycle.watchPositions ?? []),
    ...(snapshot?.portfolioLifecycle.exitedPositions ?? []),
  ];
  const position =
    allPositions.find((item) => item.tokenAddress.toLowerCase() === tokenAddress.toLowerCase()) ?? null;
  const timeline = (snapshot?.portfolioLifecycle.timeline ?? []).filter(
    (event) => event.tokenAddress.toLowerCase() === tokenAddress.toLowerCase()
  );

  return {
    tokenAddress,
    tokenSymbol: position?.tokenSymbol ?? "Unknown",
    position,
    timeline,
  };
}

function renderBrandLogoSvg(): string {
  return `
    <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <rect x="1.5" y="1.5" width="61" height="61" rx="20" fill="#FFD60A" stroke="rgba(0,0,0,.18)" />
      <circle cx="17" cy="14" r="6" fill="rgba(0,0,0,.12)" />
      <circle cx="10" cy="24" r="4" fill="rgba(0,0,0,.12)" />
      <path d="M46 20c0 11-8 22-22 26 6-4 8-7 8-10-6 1-11-1-13-5-1-3 0-7 3-10 4-4 9-7 16-7 4 0 8 2 8 6Z" fill="#0A0A0A"/>
      <path d="M44 16c2 1 3 3 3 6 0 8-5 18-15 24 12-3 20-14 20-25 0-6-3-10-8-12-4-2-8-2-14 0 5 0 10 2 14 7Z" fill="#0A0A0A"/>
      <path d="M18 35c5 1 9 0 14-3-2 5-7 9-14 10-4 0-7-2-8-5 2-1 5-2 8-2Z" fill="#FFD9C3"/>
      <path d="M24 27c3-3 6-4 10-4-4 1-7 3-10 7-1 1-2 1-3 0 0-1 1-2 3-3Z" fill="#FFD9C3"/>
      <path d="M34 28c2-1 4-1 6 0-2 1-4 1-6 0Z" fill="#0A0A0A"/>
      <path d="M39 33h4v10h-4z" fill="#0A0A0A"/>
      <rect x="38" y="31" width="6" height="6" rx="1.5" fill="#FFD60A" stroke="#0A0A0A" stroke-width="1.4"/>
    </svg>`;
}

function renderBrandLogoImage(className = "brand-image"): string {
  return `<img class="${className}" src="/assets/elizaok-logo.png" alt="ElizaOK logo" />`;
}

function renderHeadBrandAssets(title: string): string {
  const safeTitle = escapeHtml(title);
  return `
  <title>${safeTitle}</title>
  <link rel="icon" type="image/png" href="/assets/elizaok-logo.png" />
  <link rel="apple-touch-icon" href="/assets/elizaok-logo.png" />
  <meta property="og:title" content="${safeTitle}" />
  <meta property="og:image" content="/assets/elizaok-logo.png" />
  <meta name="twitter:card" content="summary" />
  <meta name="twitter:title" content="${safeTitle}" />
  <meta name="twitter:image" content="/assets/elizaok-logo.png" />`;
}

function renderGithubIconSvg(): string {
  return `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 .5a12 12 0 0 0-3.79 23.39c.6.12.82-.26.82-.58v-2.04c-3.34.73-4.04-1.42-4.04-1.42-.54-1.38-1.34-1.75-1.34-1.75-1.1-.74.08-.73.08-.73 1.22.09 1.86 1.25 1.86 1.25 1.08 1.86 2.84 1.32 3.53 1.01.11-.79.42-1.32.76-1.63-2.67-.3-5.47-1.34-5.47-5.95 0-1.31.47-2.38 1.24-3.22-.13-.31-.54-1.53.12-3.19 0 0 1.01-.32 3.3 1.23a11.4 11.4 0 0 1 6 0c2.28-1.55 3.29-1.23 3.29-1.23.66 1.66.25 2.88.12 3.19.77.84 1.24 1.91 1.24 3.22 0 4.62-2.8 5.65-5.48 5.95.43.37.81 1.1.81 2.23v3.31c0 .32.21.7.82.58A12 12 0 0 0 12 .5Z"/></svg>`;
}

function renderXIconSvg(): string {
  return `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M18.9 2H22l-6.77 7.74L23.2 22h-6.26l-4.9-7.4L5.53 22H2.4l7.24-8.28L1.2 2H7.6l4.43 6.73L18.9 2Zm-1.1 18h1.73L6.66 3.9H4.8L17.8 20Z"/></svg>`;
}

function renderNavGlyph(view: string): string {
  const glyphs: Record<string, string> = {
    overview: "◉",
    discovery: "△",
    portfolio: "▣",
    treasury: "◌",
    watchlist: "✦",
    distribution: "◫",
    goo: "◎",
    reports: "≣",
  };
  return glyphs[view] || "•";
}

function renderProgress(label: string, current: number, max: number, meta: string): string {
  const pct = max > 0 ? clampPercent((current / max) * 100) : 0;
  return `
    <div class="progress-card">
      <div class="progress-head">
        <span>${escapeHtml(label)}</span>
        <strong>${escapeHtml(meta)}</strong>
      </div>
      <div class="progress-track">
        <div class="progress-fill" style="width:${pct}%"></div>
      </div>
    </div>`;
}

function renderMetricCard(label: string, value: string, detail: string): string {
  return `
    <article class="metric-card">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
      <p>${escapeHtml(detail)}</p>
    </article>`;
}

function renderFeatureDockCard(
  href: string,
  label: string,
  value: string,
  meta: string,
  pct: number,
  tone: "hot" | "warm" | "cool" = "cool"
): string {
  const safePct = clampPercent(pct);
  return `
    <a class="feature-dock-card feature-dock-card--${tone}" href="${href}">
      <div class="feature-dock-card__top">
        <span>${escapeHtml(label)}</span>
        <em>${safePct}%</em>
      </div>
      <strong>${escapeHtml(value)}</strong>
      <small>${escapeHtml(meta)}</small>
      <div class="feature-dock-card__track">
        <div class="feature-dock-card__fill" style="width:${safePct}%"></div>
      </div>
    </a>`;
}

function formatPct(value: number | null): string {
  if (value === null || Number.isNaN(value)) return "n/a";
  return `${Math.round(value)}%`;
}

function formatDuration(ms: number | null): string {
  if (ms === null || ms <= 0 || Number.isNaN(ms)) return "n/a";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = ms / 3_600_000;
  if (hours < 24) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

function formatRelativeTime(iso: string | null): string {
  if (!iso) return "n/a";
  const diff = Date.now() - Date.parse(iso);
  if (!Number.isFinite(diff) || diff < 0) return iso;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function renderUsageRow(label: string, pct: number, value: string): string {
  const blockCount = 10;
  const activeBlocks = Math.max(0, Math.min(blockCount, Math.round((pct / 100) * blockCount)));
  return `
    <div class="usage-row">
      <span>${escapeHtml(label)}</span>
      <div class="usage-meter">
        ${Array.from({ length: blockCount }, (_, index) => `<i class="${index < activeBlocks ? "is-on" : ""}"></i>`).join("")}
      </div>
      <strong>${escapeHtml(value)}</strong>
    </div>`;
}

function renderCandidateDetail(
  detail: CandidateDetail,
  portfolioDetail: PortfolioPositionDetail | null
): string {
  const historyRows = detail.history
    .map(
      (entry) => `
        <tr>
          <td>${escapeHtml(entry.generatedAt)}</td>
          <td>${entry.score}</td>
          <td>${escapeHtml(entry.recommendation)}</td>
          <td>${formatUsd(entry.reserveUsd)}</td>
          <td>${formatUsd(entry.volumeUsdM5)}</td>
        </tr>`
    )
    .join("");
  const position = portfolioDetail?.position ?? null;
  const treasuryTimelineRows =
    portfolioDetail?.timeline
      .map(
        (event) => `
        <tr>
          <td>${escapeHtml(event.generatedAt)}</td>
          <td>${escapeHtml(event.type)}</td>
          <td>${escapeHtml(event.stateAfter)}</td>
          <td>${escapeHtml(event.detail)}</td>
        </tr>`
      )
      .join("") || "";
  const backHref = `/?view=discovery`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  ${renderHeadBrandAssets(`${detail.tokenSymbol} | ElizaOK`)}
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Kode+Mono:wght@400;500;700&display=swap" rel="stylesheet">
  <style>
    :root {
      color-scheme: dark;
      --bg: #16130e;
      --bg-soft: #242017;
      --panel: rgba(24,21,16,.9);
      --border: rgba(215,164,40,.16);
      --border-strong: rgba(240,198,79,.3);
      --text: #f4ecd2;
      --muted: #bca36d;
      --accent: #d7a428;
      --shadow: rgba(0,0,0,.55);
    }
    * { box-sizing:border-box; }
    body {
      margin:0;
      background:
        radial-gradient(circle at 18% 14%, rgba(215,164,40,.08), transparent 18%),
        radial-gradient(circle at 82% 22%, rgba(215,164,40,.04), transparent 16%),
        linear-gradient(180deg, #040404 0%, #080808 55%, #060606 100%);
      color:var(--text);
      font-family:"Kode Mono", monospace;
      padding:24px;
    }
    body::before {
      content:"";
      position:fixed;
      inset:0;
      pointer-events:none;
      background-image:
        linear-gradient(rgba(215,164,40,.018) 1px, transparent 1px),
        linear-gradient(90deg, rgba(215,164,40,.018) 1px, transparent 1px),
        repeating-linear-gradient(180deg, rgba(255,255,255,0.018) 0 1px, transparent 1px 18px);
      background-size:34px 34px, 34px 34px, 100% 18px;
      mask-image:linear-gradient(180deg, rgba(0,0,0,.82), transparent);
    }
    body::after {
      content:"";
      position:fixed;
      inset:0;
      pointer-events:none;
      background:
        radial-gradient(circle at 18% 20%, rgba(255,255,255,.03), transparent 14%),
        radial-gradient(circle at 72% 24%, rgba(215,164,40,.05), transparent 18%),
        radial-gradient(circle at 60% 76%, rgba(215,164,40,.035), transparent 18%);
      opacity:.7;
    }
    a { color:inherit; text-decoration:none; }
    .shell { max-width:1240px; margin:0 auto; position:relative; z-index:1; }
    .topbar {
      display:flex;
      justify-content:space-between;
      align-items:center;
      gap:16px;
      padding:16px 20px;
      margin-bottom:18px;
      border-radius:24px;
      border:1px solid var(--border);
      background:rgba(20,18,14,.82);
      box-shadow:0 18px 48px rgba(0,0,0,.28);
      backdrop-filter:blur(10px);
    }
    .topbar-left { display:flex; align-items:center; gap:12px; flex-wrap:wrap; }
    .brand-logo {
      width: 48px;
      height: 48px;
      border-radius: 14px;
      overflow: hidden;
      border: 1px solid rgba(255,214,10,.18);
      box-shadow: 0 0 24px rgba(255,214,10,.12);
      background: rgba(215,164,40,.06);
      display: grid;
      place-items: center;
    }
    .brand-image {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }
    .live-dot {
      width:12px;
      height:12px;
      border-radius:999px;
      background:var(--accent);
      box-shadow:0 0 18px rgba(255,214,10,.72);
    }
    .brand strong { display:block; font-size:14px; text-transform:uppercase; letter-spacing:.08em; }
    .brand small { display:block; color:var(--muted); font-size:11px; text-transform:uppercase; letter-spacing:.12em; }
    .top-chip {
      padding:10px 13px;
      border-radius:999px;
      background:rgba(255,214,10,.07);
      border:1px solid rgba(255,214,10,.14);
      font-size:12px;
    }
    .social-actions { display:flex; gap:10px; }
    .social-link, .back-link {
      display:inline-flex;
      align-items:center;
      justify-content:center;
      gap:8px;
      height:44px;
      padding:0 14px;
      border-radius:14px;
      border:1px solid rgba(255,214,10,.14);
      background:rgba(255,214,10,.04);
      transition:180ms ease;
    }
    .social-link { width:44px; padding:0; }
    .social-link:hover, .back-link:hover {
      color:var(--accent);
      border-color:var(--border-strong);
      box-shadow:0 0 24px rgba(255,214,10,.1);
      transform:translateY(-1px);
    }
    .social-link svg { width:20px; height:20px; }
    .hero, .card {
      border-radius:28px;
      border:1px solid var(--border);
      background:
        linear-gradient(180deg, rgba(255,214,10,.07), rgba(255,214,10,.015)),
        var(--panel);
      box-shadow:0 24px 72px var(--shadow);
      overflow:hidden;
      position:relative;
    }
    .hero {
      padding:28px;
      margin-bottom:18px;
    }
    .hero::before {
      content:"";
      position:absolute;
      inset:-20% auto auto 62%;
      width:300px;
      height:300px;
      border-radius:50%;
      background:radial-gradient(circle, rgba(255,214,10,.18), transparent 68%);
    }
    .eyebrow {
      display:inline-flex;
      align-items:center;
      gap:10px;
      color:var(--accent);
      text-transform:uppercase;
      letter-spacing:.18em;
      font-size:11px;
    }
    .eyebrow::before {
      content:"";
      width:8px;
      height:8px;
      border-radius:999px;
      background:var(--accent);
      box-shadow:0 0 14px rgba(255,214,10,.7);
    }
    h1 {
      margin:16px 0 10px;
      font-size:clamp(40px, 6vw, 72px);
      line-height:.95;
      letter-spacing:-.05em;
      max-width:8ch;
    }
    p { color:var(--muted); line-height:1.8; margin:0; }
    .hero-copy { max-width:760px; }
    .hero-meta {
      display:flex;
      flex-wrap:wrap;
      gap:10px;
      margin-top:18px;
    }
    .hero-meta .top-chip { color:var(--text); }
    .grid, .split-grid {
      display:grid;
      gap:18px;
      margin-bottom:18px;
    }
    .grid { grid-template-columns:repeat(3,minmax(0,1fr)); }
    .split-grid { grid-template-columns:1.15fr .85fr; }
    .card { padding:24px; }
    .metric {
      padding:16px;
      border-radius:18px;
      background:rgba(255,214,10,.05);
      border:1px solid rgba(255,214,10,.12);
    }
    .metric span {
      display:block;
      color:var(--muted);
      font-size:11px;
      text-transform:uppercase;
      letter-spacing:.14em;
      margin-bottom:8px;
    }
    .metric strong { font-size:22px; line-height:1.35; }
    .stack { display:grid; gap:14px; }
    table { width:100%; border-collapse:collapse; }
    th, td {
      padding:12px 10px;
      border-bottom:1px solid rgba(255,214,10,.08);
      text-align:left;
      font-size:13px;
      vertical-align:top;
    }
    th { color:var(--accent); font-size:11px; text-transform:uppercase; letter-spacing:.14em; }
    .table-shell {
      border-radius:18px;
      overflow:hidden;
      border:1px solid rgba(255,214,10,.08);
      background:rgba(255,214,10,.03);
    }
    .footer-note {
      margin-top:16px;
      font-size:12px;
      color:var(--muted);
      line-height:1.8;
      word-break:break-word;
    }
    @media (max-width: 980px) {
      .grid, .split-grid { grid-template-columns:1fr; }
      .topbar { flex-direction:column; align-items:flex-start; }
      .social-actions { width:100%; justify-content:flex-end; }
    }
  </style>
</head>
<body>
  <main class="shell">
    <header class="topbar">
      <div class="topbar-left">
        <div class="live-dot" aria-hidden="true"></div>
        <div class="brand-logo">${renderBrandLogoImage()}</div>
        <div class="brand">
          <strong>Candidate Detail</strong>
          <small></small>
        </div>
        <div class="top-chip">${escapeHtml(shortAddress(detail.tokenAddress))}</div>
        <div class="top-chip">${escapeHtml(detail.latest.recommendation)}</div>
      </div>
      <div class="social-actions">
        <a class="back-link" href="${backHref}">Back</a>
        <a class="social-link" href="https://github.com/elizaokbsc" target="_blank" rel="noreferrer" aria-label="GitHub">
          ${renderGithubIconSvg()}
        </a>
        <a class="social-link" href="https://x.com/elizaok_bsc" target="_blank" rel="noreferrer" aria-label="X">
          ${renderXIconSvg()}
        </a>
      </div>
    </header>
    <section class="hero">
      <div class="eyebrow">elizaok</div>
      <h1>${escapeHtml(detail.tokenSymbol)}</h1>
      <div class="hero-meta">
        <div class="top-chip">Latest score ${detail.latest.score}/100</div>
        <div class="top-chip">Conviction ${escapeHtml(detail.latest.conviction)}</div>
        <div class="top-chip">Appearances ${detail.history.length}</div>
      </div>
    </section>
    <div class="grid">
      <div class="grid">
        <div class="metric"><span>Latest score</span><strong>${detail.latest.score}/100</strong></div>
        <div class="metric"><span>Conviction</span><strong>${escapeHtml(detail.latest.conviction)}</strong></div>
        <div class="metric"><span>Appearances</span><strong>${detail.history.length}</strong></div>
      </div>
    </div>
    <section class="split-grid">
    <div class="card">
      <div class="eyebrow">Treasury Position</div>
      <div class="grid">
        <div class="metric"><span>State</span><strong>${escapeHtml(position?.state || "not_in_portfolio")}</strong></div>
        <div class="metric"><span>Lane</span><strong>${escapeHtml(position?.executionSource || "n/a")}</strong></div>
        <div class="metric"><span>Wallet</span><strong>${escapeHtml(position?.walletVerification || "n/a")}</strong></div>
        <div class="metric"><span>Realized PnL</span><strong>${position ? `${position.realizedPnlUsd >= 0 ? "+" : ""}${formatUsd(position.realizedPnlUsd)}` : "n/a"}</strong></div>
        <div class="metric"><span>Unrealized PnL</span><strong>${position ? `${position.unrealizedPnlUsd >= 0 ? "+" : ""}${formatUsd(position.unrealizedPnlUsd)}` : "n/a"}</strong></div>
        <div class="metric"><span>Initial allocation</span><strong>${position ? formatUsd(position.initialAllocationUsd) : "n/a"}</strong></div>
        <div class="metric"><span>Current allocation</span><strong>${position ? formatUsd(position.allocationUsd) : "n/a"}</strong></div>
        <div class="metric"><span>Token balance</span><strong>${escapeHtml(position?.walletTokenBalance || "n/a")}</strong></div>
        <div class="metric"><span>Quote route</span><strong>${escapeHtml(position?.walletQuoteRoute || "n/a")}</strong></div>
        <div class="metric"><span>Quote value</span><strong>${position?.walletQuoteUsd !== null && position?.walletQuoteUsd !== undefined ? formatUsd(position.walletQuoteUsd) : "n/a"}</strong></div>
        <div class="metric"><span>TP stages hit</span><strong>${position ? `${position.takeProfitCount} (${escapeHtml(position.takeProfitStagesHit.join(", ") || "none")})` : "n/a"}</strong></div>
      </div>
      <div class="metric"><span>Portfolio</span><strong><a href="${portfolioHref(detail.tokenAddress)}">open api</a></strong></div>
    </div>
    <div class="card">
      <div class="eyebrow">Latest State</div>
      <div class="grid">
        <div class="metric"><span>Recommendation</span><strong>${escapeHtml(detail.latest.recommendation)}</strong></div>
        <div class="metric"><span>Liquidity</span><strong>${formatUsd(detail.latest.reserveUsd)}</strong></div>
        <div class="metric"><span>Volume 5m</span><strong>${formatUsd(detail.latest.volumeUsdM5)}</strong></div>
        <div class="metric"><span>Age</span><strong>${detail.latest.poolAgeMinutes}m</strong></div>
        <div class="metric"><span>FDV</span><strong>${detail.latest.fdvUsd !== null ? formatUsd(detail.latest.fdvUsd) : "n/a"}</strong></div>
        <div class="metric"><span>Market cap</span><strong>${detail.latest.marketCapUsd !== null ? formatUsd(detail.latest.marketCapUsd) : "n/a"}</strong></div>
      </div>
    </div>
    </section>
    <div class="card">
      <div class="eyebrow">Run history</div>
      <div class="table-shell"><table>
        <thead>
          <tr><th>Generated</th><th>Score</th><th>Recommendation</th><th>Liquidity</th><th>Volume 5m</th></tr>
        </thead>
        <tbody>${historyRows}</tbody>
      </table></div>
    </div>
    <div class="card">
      <div class="eyebrow">Treasury timeline</div>
      <div class="table-shell"><table>
        <thead>
          <tr><th>Generated</th><th>Event</th><th>State after</th><th>Detail</th></tr>
        </thead>
        <tbody>${treasuryTimelineRows || "<tr><td colspan=\"4\">No treasury lifecycle events yet.</td></tr>"}</tbody>
      </table></div>
    </div>
  </main>
</body>
</html>`;
}

function renderGooCandidateDetail(
  detail: ReturnType<typeof buildGooCandidateDetail>
): string {
  const { candidate, readiness, urgency, treasuryStressGapBnb, operatorAction, acquisitionFit, pulseWindowLabel } =
    detail;
  const backHref = `/?view=goo`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  ${renderHeadBrandAssets(`Goo Agent ${candidate.agentId} | ElizaOK`)}
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Kode+Mono:wght@400;500;700&display=swap" rel="stylesheet">
  <style>
    :root {
      color-scheme: dark;
      --bg: #16130e;
      --bg-soft: #242017;
      --panel: rgba(24,21,16,.9);
      --border: rgba(215,164,40,.16);
      --border-strong: rgba(240,198,79,.3);
      --text: #f4ecd2;
      --muted: #bca36d;
      --accent: #d7a428;
      --shadow: rgba(0,0,0,.55);
    }
    * { box-sizing:border-box; }
    body {
      margin:0;
      background:
        radial-gradient(circle at 8% 18%, rgba(244,239,221,.78), rgba(244,239,221,.12) 18%, transparent 42%),
        linear-gradient(90deg, rgba(244,239,221,.06), transparent 28%),
        linear-gradient(180deg, var(--bg) 0%, var(--bg-soft) 100%);
      color:var(--text);
      font-family:"Kode Mono", monospace;
      padding:24px;
    }
    body::before {
      content:"";
      position:fixed;
      inset:0;
      pointer-events:none;
      background-image:
        linear-gradient(rgba(215,164,40,.022) 1px, transparent 1px),
        linear-gradient(90deg, rgba(215,164,40,.022) 1px, transparent 1px);
      background-size:34px 34px;
      mask-image:linear-gradient(180deg, rgba(0,0,0,.82), transparent);
    }
    body::after {
      content:"";
      position:fixed;
      inset:0;
      pointer-events:none;
      background:
        radial-gradient(circle at 18% 20%, rgba(244,239,221,.08), transparent 14%),
        radial-gradient(circle at 72% 24%, rgba(215,164,40,.05), transparent 18%),
        radial-gradient(circle at 60% 76%, rgba(215,164,40,.04), transparent 18%);
      opacity:.9;
    }
    a { color:inherit; text-decoration:none; }
    .shell { max-width:1240px; margin:0 auto; position:relative; z-index:1; }
    .topbar {
      display:flex;
      justify-content:space-between;
      align-items:center;
      gap:16px;
      padding:16px 20px;
      margin-bottom:18px;
      border-radius:24px;
      border:1px solid var(--border);
      background:rgba(20,18,14,.82);
      box-shadow:0 18px 48px rgba(0,0,0,.28);
      backdrop-filter:blur(10px);
    }
    .topbar-left { display:flex; align-items:center; gap:12px; flex-wrap:wrap; }
    .brand-logo {
      width: 48px;
      height: 48px;
      border-radius: 14px;
      overflow: hidden;
      border: 1px solid rgba(255,214,10,.18);
      box-shadow: 0 0 24px rgba(215,164,40,.12);
      background: rgba(215,164,40,.06);
      display: grid;
      place-items: center;
    }
    .brand-image {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }
    .live-dot {
      width:12px;
      height:12px;
      border-radius:999px;
      background:var(--accent);
      box-shadow:0 0 18px rgba(255,214,10,.72);
    }
    .brand strong { display:block; font-size:14px; text-transform:uppercase; letter-spacing:.08em; }
    .brand small { display:block; color:var(--muted); font-size:11px; text-transform:uppercase; letter-spacing:.12em; }
    .top-chip {
      padding:10px 13px;
      border-radius:999px;
      background:rgba(255,214,10,.07);
      border:1px solid rgba(255,214,10,.14);
      font-size:12px;
    }
    .social-actions { display:flex; gap:10px; }
    .social-link, .back-link {
      display:inline-flex;
      align-items:center;
      justify-content:center;
      gap:8px;
      height:44px;
      padding:0 14px;
      border-radius:14px;
      border:1px solid rgba(255,214,10,.14);
      background:rgba(255,214,10,.04);
      transition:180ms ease;
    }
    .social-link { width:44px; padding:0; }
    .social-link:hover, .back-link:hover {
      color:var(--accent);
      border-color:var(--border-strong);
      box-shadow:0 0 24px rgba(255,214,10,.1);
      transform:translateY(-1px);
    }
    .social-link svg { width:20px; height:20px; }
    .hero, .card {
      border-radius:28px;
      border:1px solid var(--border);
      background:
        linear-gradient(180deg, rgba(215,164,40,.08), rgba(215,164,40,.02)),
        var(--panel);
      box-shadow:0 24px 72px var(--shadow);
      overflow:hidden;
      position:relative;
    }
    .hero {
      padding:28px;
      margin-bottom:18px;
    }
    .hero::before {
      content:"";
      position:absolute;
      inset:-20% auto auto 62%;
      width:300px;
      height:300px;
      border-radius:50%;
      background:radial-gradient(circle, rgba(215,164,40,.18), transparent 68%);
    }
    .eyebrow {
      display:inline-flex;
      align-items:center;
      gap:10px;
      color:var(--accent);
      text-transform:uppercase;
      letter-spacing:.18em;
      font-size:11px;
    }
    .eyebrow::before {
      content:"";
      width:8px;
      height:8px;
      border-radius:999px;
      background:var(--accent);
      box-shadow:0 0 14px rgba(255,214,10,.7);
    }
    h1 {
      margin:16px 0 10px;
      font-size:clamp(40px, 6vw, 72px);
      line-height:.95;
      letter-spacing:-.05em;
      max-width:8ch;
    }
    p { color:var(--muted); line-height:1.8; margin:0; }
    .hero-copy { max-width:760px; }
    .hero-meta { display:flex; flex-wrap:wrap; gap:10px; margin-top:18px; }
    .hero-meta .top-chip { color:var(--text); }
    .grid, .split-grid {
      display:grid;
      gap:18px;
      margin-bottom:18px;
    }
    .grid { grid-template-columns:repeat(3,minmax(0,1fr)); }
    .split-grid { grid-template-columns:1.1fr .9fr; }
    .card { padding:24px; }
    .metric {
      padding:16px;
      border-radius:18px;
      background:rgba(255,214,10,.05);
      border:1px solid rgba(255,214,10,.12);
    }
    .metric span {
      display:block;
      color:var(--muted);
      font-size:11px;
      text-transform:uppercase;
      letter-spacing:.14em;
      margin-bottom:8px;
    }
    .metric strong { font-size:22px; line-height:1.35; }
    .progress-track { height:10px; border-radius:999px; background:rgba(255,214,10,.08); overflow:hidden; margin-top:12px; }
    .progress-fill { height:100%; background:linear-gradient(90deg,#9c6a00,#ffd60a); width:${Math.round(
      (readiness.score / readiness.total) * 100
    )}%; box-shadow:0 0 18px rgba(255,214,10,.45); }
    .table-shell {
      border-radius:18px;
      overflow:hidden;
      border:1px solid rgba(255,214,10,.08);
      background:rgba(255,214,10,.03);
    }
    ul { margin:0; padding-left:18px; }
    li { margin-bottom:10px; color:var(--text); line-height:1.8; }
    @media (max-width:980px) {
      .grid, .split-grid { grid-template-columns:1fr; }
      .topbar { flex-direction:column; align-items:flex-start; }
      .social-actions { width:100%; justify-content:flex-end; }
    }
  </style>
</head>
<body>
  <main class="shell">
    <header class="topbar">
      <div class="topbar-left">
        <div class="live-dot" aria-hidden="true"></div>
        <div class="brand-logo">${renderBrandLogoImage()}</div>
        <div class="brand">
          <strong>Goo Operator Detail</strong>
          <small></small>
        </div>
        <div class="top-chip">Agent ${escapeHtml(candidate.agentId)}</div>
        <div class="top-chip">${escapeHtml(candidate.recommendation)}</div>
        <div class="top-chip">${escapeHtml(urgency)} urgency</div>
      </div>
      <div class="social-actions">
        <a class="back-link" href="${backHref}">Back</a>
        <a class="social-link" href="https://github.com/elizaokbsc" target="_blank" rel="noreferrer" aria-label="GitHub">
          ${renderGithubIconSvg()}
        </a>
        <a class="social-link" href="https://x.com/elizaok_bsc" target="_blank" rel="noreferrer" aria-label="X">
          ${renderXIconSvg()}
        </a>
      </div>
    </header>
    <section class="hero">
      <div class="eyebrow">elizaok</div>
      <h1>Agent ${escapeHtml(candidate.agentId)}</h1>
      <div class="hero-meta">
        <div class="top-chip">Score ${candidate.score}/100</div>
        <div class="top-chip">Pulse ${escapeHtml(pulseWindowLabel)}</div>
        <div class="top-chip">CTO floor ${candidate.minimumCtoBnb} BNB</div>
      </div>
    </section>
    <div class="card">
      <div class="grid">
        <div class="metric"><span>Score</span><strong>${candidate.score}/100</strong></div>
        <div class="metric"><span>CTO floor</span><strong>${candidate.minimumCtoBnb} BNB</strong></div>
        <div class="metric"><span>Treasury</span><strong>${candidate.treasuryBnb} BNB</strong></div>
        <div class="metric"><span>Pulse deadline</span><strong>${escapeHtml(pulseWindowLabel)}</strong></div>
        <div class="metric"><span>Treasury gap</span><strong>${candidate.status === "ACTIVE" ? "0 BNB" : `${treasuryStressGapBnb.toFixed(4)} BNB`}</strong></div>
        <div class="metric"><span>Acquisition fit</span><strong>${escapeHtml(acquisitionFit)}</strong></div>
      </div>
    </div>
    <div class="split-grid">
    <div class="card">
      <div class="eyebrow">Readiness</div>
      <div class="progress-track"><div class="progress-fill"></div></div>
      <p>${readiness.score}/${readiness.total}</p>
      <ul>${readiness.checklist.map((item) => `<li>${item.done ? "READY" : "TODO"} · ${escapeHtml(item.label)} · ${escapeHtml(item.detail)}</li>`).join("")}</ul>
    </div>
    <div class="card">
      <div class="eyebrow">Action</div>
      <div class="grid">
        <div class="metric"><span>Urgency</span><strong>${escapeHtml(urgency)}</strong></div>
        <div class="metric"><span>Action</span><strong>${escapeHtml(operatorAction)}</strong></div>
        <div class="metric"><span>Next</span><strong>${escapeHtml(readiness.nextAction)}</strong></div>
        <div class="metric"><span>Status</span><strong>${escapeHtml(candidate.status)}</strong></div>
      </div>
    </div>
    </div>
    <div class="split-grid">
    <div class="card">
      <div class="eyebrow">Links</div>
      <div class="grid">
        <div class="metric"><span>Genome</span><strong><a href="${escapeHtml(candidate.genomeUri)}" target="_blank" rel="noreferrer">open</a></strong></div>
        <div class="metric"><span>Token</span><strong>${escapeHtml(shortAddress(candidate.tokenAddress))}</strong></div>
        <div class="metric"><span>Wallet</span><strong>${escapeHtml(shortAddress(candidate.agentWallet))}</strong></div>
        <div class="metric"><span>Owner</span><strong>${escapeHtml(shortAddress(candidate.ownerAddress))}</strong></div>
      </div>
    </div>
    <div class="card">
      <div class="eyebrow">State</div>
      <div class="grid">
        <div class="metric"><span>Recommendation</span><strong>${escapeHtml(candidate.recommendation)}</strong></div>
        <div class="metric"><span>Registered block</span><strong>${candidate.registeredAtBlock}</strong></div>
        <div class="metric"><span>Threshold</span><strong>${candidate.starvingThresholdBnb} BNB</strong></div>
        <div class="metric"><span>Risks</span><strong>${candidate.risks.length}</strong></div>
      </div>
    </div>
    </div>
  </main>
</body>
</html>`;
}

function pnlTone(value: number): string {
  if (value > 0) return "tone-hot";
  if (value < 0) return "tone-warm";
  return "tone-cool";
}

function renderHtml(snapshot: DashboardSnapshot | null): string {
  if (!snapshot) {
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  ${renderHeadBrandAssets("ElizaOK | elizaOK_BSC")}
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Kode+Mono:wght@400;500;700&display=swap" rel="stylesheet">
  <style>
    :root {
      color-scheme: dark;
      --bg: #16130e;
      --panel: rgba(24, 21, 16, 0.88);
      --panel-border: rgba(215, 164, 40, 0.2);
      --text: #f4ecd2;
      --muted: #bca36d;
      --accent: #d7a428;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 32px;
      background:
        radial-gradient(circle at 8% 18%, rgba(244,239,221,0.78), rgba(244,239,221,0.12) 18%, transparent 42%),
        linear-gradient(90deg, rgba(244,239,221,0.06), transparent 28%),
        linear-gradient(180deg, #16130e 0%, #242017 100%);
      font-family: "Kode Mono", monospace;
      color: var(--text);
    }
    .panel {
      width: min(920px, 100%);
      padding: 32px;
      border: 1px solid var(--panel-border);
      border-radius: 24px;
      background: var(--panel);
      box-shadow: 0 24px 80px rgba(0, 0, 0, 0.45);
    }
    .eyebrow {
      color: var(--accent);
      text-transform: uppercase;
      letter-spacing: 0.18em;
      font-size: 12px;
      margin-bottom: 12px;
    }
    h1 {
      margin: 0 0 8px;
      font-size: clamp(36px, 5vw, 56px);
      line-height: 1;
    }
    p { color: var(--muted); line-height: 1.65; }
  </style>
</head>
<body>
  <main class="panel">
    <div class="eyebrow">ElizaOK Live System</div>
    <h1>Dashboard warming up</h1>
    <p>No scan snapshot is available yet. The agent is online and waiting for the first discovery cycle to complete.</p>
  </main>
</body>
</html>`;
  }

  const treasurySimulation = snapshot.treasurySimulation ?? {
    paperCapitalUsd: 0,
    deployableCapitalUsd: 0,
    allocatedUsd: 0,
    dryPowderUsd: 0,
    reserveUsd: 0,
    reservePct: 0,
    positionCount: 0,
    averagePositionUsd: 0,
    highestConvictionSymbol: undefined,
    strategyNote: "Treasury simulation will appear after the next completed scan.",
    positions: [],
  };
  const portfolioLifecycle = snapshot.portfolioLifecycle ?? {
    activePositions: [],
    watchPositions: [],
    exitedPositions: [],
    timeline: [],
    cashBalanceUsd: 0,
    grossPortfolioValueUsd: 0,
    reservedUsd: 0,
    totalAllocatedUsd: 0,
    totalCurrentValueUsd: 0,
    totalRealizedPnlUsd: 0,
    totalUnrealizedPnlUsd: 0,
    totalUnrealizedPnlPct: 0,
    healthNote: "Portfolio lifecycle will appear after the next completed scan.",
  };
  const distributionPlan = snapshot.distributionPlan ?? {
    enabled: false,
    holderTokenAddress: null,
    snapshotPath: ".elizaok/holder-snapshot.json",
    snapshotSource: "none",
    snapshotGeneratedAt: null,
    snapshotBlockNumber: null,
    minEligibleBalance: 0,
    eligibleHolderCount: 0,
    totalQualifiedBalance: 0,
    distributionPoolUsd: 0,
    maxRecipients: 0,
    note: "Distribution state will appear after configuration is enabled.",
    selectedAsset: {
      mode: "none",
      tokenAddress: null,
      tokenSymbol: null,
      totalAmount: null,
      walletBalance: null,
      walletQuoteUsd: null,
      sourcePositionTokenAddress: null,
      reason: "Distribution asset selection will appear after configuration is enabled.",
    },
    recipients: [],
    publication: null,
  };
  const distributionExecution = snapshot.distributionExecution ?? {
    enabled: false,
    dryRun: true,
    configured: false,
    liveExecutionArmed: false,
    readinessScore: 0,
    readinessTotal: 0,
    readinessChecks: [],
    nextAction: "Distribution execution state will appear after the next completed scan.",
    assetTokenAddress: null,
    assetTotalAmount: null,
    walletAddress: null,
    manifestPath: null,
    manifestFingerprint: null,
    maxRecipientsPerRun: 0,
    cycleSummary: {
      attemptedCount: 0,
      dryRunCount: 0,
      executedCount: 0,
      skippedCount: 0,
      failedCount: 0,
      note: "Distribution execution is idle.",
    },
  };
  const distributionLedger = snapshot.distributionLedger ?? {
    records: [],
    lastUpdatedAt: null,
    totalRecipientsExecuted: 0,
    totalRecipientsDryRun: 0,
  };
  const executionState = snapshot.executionState ?? {
    enabled: false,
    dryRun: true,
    mode: "paper",
    router: "fourmeme",
    configured: false,
    liveTradingArmed: false,
    readinessScore: 0,
    readinessTotal: 0,
    readinessChecks: [],
    nextAction: "Execution state will appear after the next completed scan.",
    risk: {
      maxBuyBnb: 0,
      maxDailyDeployBnb: 0,
      maxSlippageBps: 0,
      maxActivePositions: 0,
      minEntryMcapUsd: 0,
      maxEntryMcapUsd: 0,
      minLiquidityUsd: 0,
      minVolumeUsdM5: 0,
      minVolumeUsdH1: 0,
      minBuyersM5: 0,
      minNetBuysM5: 0,
      minPoolAgeMinutes: 0,
      maxPoolAgeMinutes: 0,
      maxPriceChangeH1Pct: 0,
      allowedQuoteOnly: true,
    },
    gooLane: undefined,
    plans: [],
    cycleSummary: {
      consideredCount: 0,
      eligibleCount: 0,
      attemptedCount: 0,
      dryRunCount: 0,
      executedCount: 0,
      skippedCount: 0,
      failedCount: 0,
      note: "Execution cycle has not run yet for this snapshot.",
    },
  };
  const tradeLedger = snapshot.tradeLedger ?? {
    records: [],
    lastUpdatedAt: null,
    totalExecutedBnb: 0,
    totalDryRunBnb: 0,
  };
  const recentHistory = snapshot.recentHistory ?? [];
  const watchlist = snapshot.watchlist ?? [];
  const eligibleExecutionPlans = executionState.plans.filter((plan) => plan.eligible).length;
  const gooReadyCount = snapshot.topGooCandidates.filter(
    (candidate) =>
      candidate.recommendation === "priority_due_diligence" ||
      candidate.recommendation === "cto_candidate"
  ).length;
  const gooConfigReadiness = [
    getDiscoveryConfig().goo.enabled ? 1 : 0,
    getDiscoveryConfig().goo.rpcUrl ? 1 : 0,
    getDiscoveryConfig().goo.registryAddress ? 1 : 0,
  ].reduce((sum, value) => sum + value, 0);
  const gooReadiness = buildGooReadiness(getDiscoveryConfig());
  const treasuryRules = getDiscoveryConfig().treasury;
  const takeProfitSummary = treasuryRules.takeProfitRules
    .map((rule) => `${rule.label} +${rule.gainPct}% -> sell ${rule.sellPct}%`)
    .join(" · ");

  const topCandidates = snapshot.topCandidates
    .slice(0, 5)
    .map(
      (candidate, index) => `
        <article class="candidate-card">
          <div class="candidate-card__meta">
            <span class="candidate-rank">0${index + 1}</span>
            <span class="pill ${recommendationTone(candidate.recommendation)}">${escapeHtml(candidate.recommendation)}</span>
          </div>
          <h3><a class="candidate-link" href="${candidateHref(candidate.tokenAddress)}">${escapeHtml(candidate.tokenSymbol)}</a></h3>
          <p class="candidate-subtitle">${escapeHtml(candidate.poolName)} · ${escapeHtml(candidate.dexId)}</p>
          <div class="candidate-stats">
            <div><span>Score</span><strong>${candidate.score}/100</strong></div>
            <div><span>Liquidity</span><strong>$${Math.round(candidate.reserveUsd).toLocaleString()}</strong></div>
            <div><span>Volume 5m</span><strong>$${Math.round(candidate.volumeUsdM5).toLocaleString()}</strong></div>
            <div><span>Age</span><strong>${candidate.poolAgeMinutes}m</strong></div>
          </div>
        </article>`
    )
    .join("");

  const gooCandidates = snapshot.topGooCandidates
    .slice(0, 5)
    .map(
      (candidate, index) => `
        <article class="goo-card">
          <div class="candidate-card__meta">
            <span class="candidate-rank">0${index + 1}</span>
            <span class="pill ${recommendationTone(candidate.recommendation)}">${escapeHtml(candidate.recommendation)}</span>
          </div>
          <h3><a class="candidate-link" href="${gooCandidateHref(candidate.agentId)}">Agent ${escapeHtml(candidate.agentId)}</a></h3>
          <p class="candidate-subtitle">${escapeHtml(candidate.status)} lifecycle · CTO floor ${candidate.minimumCtoBnb} BNB · <a class="candidate-link" href="${gooCandidateHref(candidate.agentId)}">operator view</a></p>
          <div class="candidate-stats">
            <div><span>Score</span><strong>${candidate.score}/100</strong></div>
            <div><span>Treasury</span><strong>${candidate.treasuryBnb} BNB</strong></div>
            <div><span>Threshold</span><strong>${candidate.starvingThresholdBnb} BNB</strong></div>
            <div><span>Pulse</span><strong>${candidate.secondsUntilPulseTimeout ?? "n/a"}s</strong></div>
          </div>
        </article>`
    )
    .join("");

  const gooQueueRows = snapshot.topGooCandidates
    .slice(0, 6)
    .map((candidate) => {
      const detail = buildGooCandidateDetail(candidate, getDiscoveryConfig());
      return `
        <div class="status-row">
          <span><a class="watchlist-link" href="${gooCandidateHref(candidate.agentId)}">Agent ${escapeHtml(candidate.agentId)}</a></span>
          <strong>
            ${escapeHtml(detail.urgency)} · ${escapeHtml(candidate.recommendation)}<br />
            ${escapeHtml(detail.operatorAction)}
          </strong>
        </div>`;
    })
    .join("");

  const treasuryAllocationCards = treasurySimulation.positions
    .slice(0, 5)
    .map(
      (position, index) => `
        <article class="candidate-card">
          <div class="candidate-card__meta">
            <span class="candidate-rank">0${index + 1}</span>
            <span class="pill tone-hot">${escapeHtml(position.recommendation)}</span>
          </div>
          <h3>${escapeHtml(position.tokenSymbol)}</h3>
          <p class="candidate-subtitle">${escapeHtml(position.source)} allocation lane</p>
          <div class="candidate-stats">
            <div><span>Allocation</span><strong>${formatUsd(position.allocationUsd)}</strong></div>
            <div><span>Weight</span><strong>${position.allocationPct}%</strong></div>
            <div><span>Score</span><strong>${position.score}/100</strong></div>
            <div><span>Liquidity</span><strong>${formatUsd(position.reserveUsd)}</strong></div>
          </div>
        </article>`
    )
    .join("");

  const recentRuns = recentHistory
    .slice(0, 6)
    .map(
      (entry) => `
        <div class="status-row">
          <span>${escapeHtml(entry.generatedAt)}</span>
          <strong>
            ${entry.candidateCount} scans / ${entry.topRecommendationCount} buys<br />
            Avg ${entry.averageScore} / Treasury ${formatUsd(entry.treasuryAllocatedUsd)}
          </strong>
        </div>`
    )
    .join("");

  const watchlistRows = watchlist
    .slice(0, 8)
    .map(
      (entry) => `
        <div class="status-row">
          <span><a class="watchlist-link" href="${candidateHref(entry.tokenAddress)}">${escapeHtml(entry.tokenSymbol)}</a></span>
          <strong>
            ${entry.currentRecommendation} · ${entry.currentScore}/100<br />
            Seen ${entry.appearances}x · Δ ${entry.scoreChange >= 0 ? "+" : ""}${entry.scoreChange}
          </strong>
        </div>`
    )
    .join("");

  const closedPositions = portfolioLifecycle.exitedPositions;
  const profitableClosedPositions = closedPositions.filter((position) => position.realizedPnlUsd > 0);
  const winRatePct = closedPositions.length
    ? (profitableClosedPositions.length / closedPositions.length) * 100
    : null;
  const tradeRecords = tradeLedger.records.filter((record) => record.plannedBuyBnb > 0);
  const averageBuyBnb = average(tradeRecords.map((record) => record.plannedBuyBnb));
  const holdDurationsMs = (closedPositions.length > 0 ? closedPositions : portfolioLifecycle.activePositions)
    .map((position) => Date.parse(position.lastUpdatedAt) - Date.parse(position.firstSeenAt))
    .filter((value) => Number.isFinite(value) && value > 0);
  const averageHoldMs = average(holdDurationsMs);
  const timezoneLabel = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const currentModel = process.env.OPENAI_MODEL?.trim() || process.env.MOLTBOOK_MODEL?.trim() || "n/a";
  const hasOpenAiKey = Boolean(process.env.OPENAI_API_KEY?.trim());
  const riskProfile =
    executionState.risk.maxBuyBnb <= 0.02 && executionState.risk.maxDailyDeployBnb <= 0.05
      ? "Conservative"
      : executionState.risk.maxBuyBnb <= 0.05 && executionState.risk.maxDailyDeployBnb <= 0.2
        ? "Balanced"
        : "Aggressive";
  const sidebarMasterCard = `
    <article class="sidebar-panel sidebar-panel--master">
      <div class="sidebar-panel__head">
        <div class="sidebar-avatar">${renderBrandLogoImage("sidebar-avatar__image")}</div>
        <div>
          <strong>elizaOK_BSC</strong>
          <small>@elizaok_bsc</small>
        </div>
      </div>
      <div class="sidebar-action-row">
        <a class="sidebar-action" href="https://x.com/elizaok_bsc" target="_blank" rel="noreferrer">X</a>
        <a class="sidebar-action" href="https://github.com/elizaokbsc" target="_blank" rel="noreferrer">GitHub</a>
      </div>
      <div class="status-panel compact-status">
        <div class="status-row"><span>TZ</span><strong>${escapeHtml(timezoneLabel)}</strong></div>
        <div class="status-row"><span>Scan</span><strong>${escapeHtml(formatRelativeTime(snapshot.generatedAt))}</strong></div>
        <div class="status-row"><span>Exec</span><strong>${escapeHtml(executionState.mode)} / ${executionState.dryRun ? "dry-run" : "live"}</strong></div>
      </div>
      <div class="sidebar-panel__title">LLM</div>
      <div class="llm-model-row">
        <span>Model</span>
        <strong>${escapeHtml(currentModel)}</strong>
      </div>
      <div class="usage-stack">
        ${renderUsageRow("API key", hasOpenAiKey ? 100 : 0, hasOpenAiKey ? "100%" : "0%")}
        ${renderUsageRow("Model set", currentModel === "n/a" ? 0 : 100, currentModel === "n/a" ? "0%" : "100%")}
      </div>
      <div class="sidebar-panel__title">System</div>
      <div class="status-panel compact-status">
        <div class="status-row"><span>Discovery</span><strong>${Math.round(getDiscoveryConfig().intervalMs / 60_000)}m</strong></div>
        <div class="status-row"><span>Buy-ready</span><strong>${eligibleExecutionPlans}</strong></div>
        <div class="status-row"><span>Distribution</span><strong>${distributionExecution.enabled ? "armed" : "standby"}</strong></div>
        <div class="status-row"><span>Goo</span><strong>${getDiscoveryConfig().goo.enabled ? "armed" : "standby"}</strong></div>
      </div>
      <div class="sidebar-panel__title">Runtime</div>
      <div class="status-panel compact-status">
        <div class="status-row"><span>Agent</span><strong>elizaOK_BSC / elizaOS</strong></div>
        <div class="status-row"><span>Health</span><strong>Discovery ${snapshot.summary.candidateCount > 0 ? "online" : "warming"} · Goo ${getDiscoveryConfig().goo.enabled ? "armed" : "standby"}</strong></div>
      </div>
    </article>`;
  const snapshotStatTiles = [
    { label: "Win Rate", value: formatPct(winRatePct) },
    { label: "Trades", value: String(tradeRecords.length) },
    { label: "Avg Hold", value: formatDuration(averageHoldMs) },
    { label: "Avg Size", value: averageBuyBnb === null ? "n/a" : formatBnb(averageBuyBnb) },
  ]
    .map(
      (item) => `
        <article class="snapshot-tile">
          <span>${escapeHtml(item.label)}</span>
          <strong>${escapeHtml(item.value)}</strong>
        </article>`
    )
    .join("");
  const discoveryPct = snapshot.summary.averageScore;
  const portfolioPct =
    portfolioLifecycle.grossPortfolioValueUsd > 0
      ? (portfolioLifecycle.totalCurrentValueUsd / portfolioLifecycle.grossPortfolioValueUsd) * 100
      : 0;
  const executionPct =
    executionState.readinessTotal > 0
      ? (executionState.readinessScore / executionState.readinessTotal) * 100
      : 0;
  const distributionPct =
    distributionExecution.readinessTotal > 0
      ? (distributionExecution.readinessScore / distributionExecution.readinessTotal) * 100
      : 0;
  const gooPct = (gooConfigReadiness / 3) * 100;
  const featureDockCards = [
    renderFeatureDockCard(
      "#discovery-section",
      "Discovery",
      `${snapshot.summary.candidateCount}`,
      `${snapshot.summary.topRecommendationCount} ready`,
      discoveryPct,
      "hot"
    ),
    renderFeatureDockCard(
      "#portfolio-section",
      "Portfolio",
      `${portfolioLifecycle.activePositions.length}`,
      `${formatUsd(portfolioLifecycle.grossPortfolioValueUsd)}`,
      portfolioPct,
      "cool"
    ),
    renderFeatureDockCard(
      "#treasury-section",
      "Execution",
      `${eligibleExecutionPlans}`,
      `${executionState.mode}`,
      executionPct,
      executionState.dryRun ? "warm" : "hot"
    ),
    renderFeatureDockCard(
      "#distribution-section",
      "Distribution",
      `${distributionPlan.eligibleHolderCount}`,
      `${distributionPlan.recipients.length} recipients`,
      distributionPct,
      distributionExecution.dryRun ? "warm" : "hot"
    ),
    renderFeatureDockCard(
      "#goo-section",
      "Goo",
      `${snapshot.summary.gooAgentCount}`,
      `${snapshot.summary.gooPriorityCount} priority`,
      gooPct,
      "cool"
    ),
  ].join("");
  const discoveryFoldSummary = `${snapshot.summary.candidateCount} scanned · ${snapshot.summary.topRecommendationCount} buy-ready · avg ${snapshot.summary.averageScore}`;
  const portfolioFoldSummary = `${portfolioLifecycle.activePositions.length} active · ${portfolioLifecycle.watchPositions.length} watch · ${formatUsd(portfolioLifecycle.grossPortfolioValueUsd)}`;
  const treasuryFoldSummary = `${formatBnb(executionState.risk.maxBuyBnb)} max buy · ${eligibleExecutionPlans} eligible · ${tradeLedger.records.length} ledger`;
  const distributionFoldSummary = `${distributionPlan.eligibleHolderCount} holders · ${distributionPlan.recipients.length} recipients · ${distributionExecution.dryRun ? "dry-run" : "live"}`;
  const gooFoldSummary = `${snapshot.summary.gooAgentCount} reviewed · ${snapshot.summary.gooPriorityCount} priority · ${gooConfigReadiness}/3 ready`;
  const overviewVisualBars = [
    renderProgress("Discovery", snapshot.summary.averageScore, 100, `${snapshot.summary.averageScore}%`),
    renderProgress("Win rate", winRatePct ?? 0, 100, formatPct(winRatePct)),
    renderProgress("Execution", executionPct, 100, `${clampPercent(executionPct)}%`),
    renderProgress("Distribution", distributionPct, 100, `${clampPercent(distributionPct)}%`),
    renderProgress("Goo", gooPct, 100, `${clampPercent(gooPct)}%`),
    renderProgress("Reserve", treasurySimulation.reservePct, 100, `${treasurySimulation.reservePct}%`),
  ].join("");
  const riskProfileBars = [
    renderProgress("Stop loss", treasuryRules.stopLossPct, 100, `${treasuryRules.stopLossPct}%`),
    renderProgress("Reserve buffer", treasurySimulation.reservePct, 100, `${treasurySimulation.reservePct}%`),
    renderProgress(
      "Daily deploy",
      executionState.risk.maxDailyDeployBnb,
      Math.max(executionState.risk.maxDailyDeployBnb, 0.1),
      formatBnb(executionState.risk.maxDailyDeployBnb)
    ),
  ].join("");
  const tradingProfileRows = `
    <div class="status-row"><span>Mode</span><strong>${escapeHtml(executionState.mode)}</strong></div>
    <div class="status-row"><span>Router</span><strong>${escapeHtml(executionState.router)}</strong></div>
    <div class="status-row"><span>Max buy</span><strong>${formatBnb(executionState.risk.maxBuyBnb)}</strong></div>
    <div class="status-row"><span>Daily deploy</span><strong>${formatBnb(executionState.risk.maxDailyDeployBnb)}</strong></div>
    <div class="status-row"><span>Max active</span><strong>${executionState.risk.maxActivePositions}</strong></div>
    <div class="status-row"><span>KOL gate</span><strong>${getDiscoveryConfig().execution.kol.enabled ? "enabled" : "off"}</strong></div>
    <div class="status-row"><span>Watchlist</span><strong>${watchlist.length}</strong></div>
    <div class="status-row"><span>Active positions</span><strong>${portfolioLifecycle.activePositions.length}</strong></div>`;

  const distributionRecipients = distributionPlan.recipients
    .slice(0, 8)
    .map(
      (recipient, index) => `
        <article class="candidate-card">
          <div class="candidate-card__meta">
            <span class="candidate-rank">0${index + 1}</span>
            <span class="pill tone-cool">${recipient.allocationPct}%</span>
          </div>
          <h3>${escapeHtml(recipient.label || shortAddress(recipient.address))}</h3>
          <p class="candidate-subtitle">${escapeHtml(shortAddress(recipient.address))}</p>
          <div class="candidate-stats">
            <div><span>Balance</span><strong>${Math.round(recipient.balance).toLocaleString()}</strong></div>
            <div><span>Allocation</span><strong>${formatUsd(recipient.allocationUsd)}</strong></div>
            <div><span>Weight</span><strong>${recipient.allocationPct}%</strong></div>
            <div><span>Status</span><strong>Eligible</strong></div>
          </div>
        </article>`
    )
    .join("");

  const distributionExecutedRecipients = new Set(
    distributionLedger.records
      .filter(
        (record) =>
          record.disposition === "executed" &&
          distributionExecution.manifestFingerprint &&
          record.manifestFingerprint === distributionExecution.manifestFingerprint
      )
      .map((record) => record.recipientAddress.toLowerCase())
  );

  const distributionPendingRecipients = distributionPlan.recipients
    .filter((recipient) => !distributionExecutedRecipients.has(recipient.address.toLowerCase()))
    .slice(0, Math.max(1, distributionExecution.maxRecipientsPerRun || 5));

  const distributionPendingRows = distributionPendingRecipients
    .map(
      (recipient) => `
        <div class="status-row">
          <span>${escapeHtml(recipient.label || shortAddress(recipient.address))}</span>
          <strong>
            ${escapeHtml(shortAddress(recipient.address))} · ${recipient.allocationPct}%<br />
            ${formatUsd(recipient.allocationUsd)} current allocation plan
          </strong>
        </div>`
    )
    .join("");

  const distributionExecutionRows = distributionExecution.readinessChecks
    .map(
      (check) => `
        <div class="status-row">
          <span>${escapeHtml(check.label)}</span>
          <strong>${check.ready ? "READY" : "TODO"}<br />${escapeHtml(check.detail)}</strong>
        </div>`
    )
    .join("");

  const distributionLedgerRows = distributionLedger.records
    .slice(0, 6)
    .map(
      (record) => `
        <div class="status-row">
          <span>${escapeHtml(shortAddress(record.recipientAddress))}</span>
          <strong>
            ${escapeHtml(record.disposition)} · ${escapeHtml(record.amount)}${record.txHash ? ` · ${escapeHtml(shortAddress(record.txHash))}` : ""}<br />
            ${escapeHtml(record.reason)}
          </strong>
        </div>`
    )
    .join("");

  const executionPlanRows = executionState.plans
    .slice(0, 6)
    .map(
      (plan) => `
        <div class="status-row">
          <span>${escapeHtml(plan.tokenSymbol)}</span>
          <strong>
            strategy ${plan.eligible ? "eligible" : "blocked"} · route ${escapeHtml(plan.routeTradable)} · ${plan.score}/100 · ${formatBnb(plan.plannedBuyBnb)}<br />
            ${escapeHtml(plan.routeReason || plan.reasons[0] || "No execution note.")}
          </strong>
        </div>`
    )
    .join("");

  const recentTradeRows = tradeLedger.records
    .slice(0, 6)
    .map(
      (trade) => `
        <div class="status-row">
          <span>${escapeHtml(trade.tokenSymbol)}</span>
          <strong>
            ${escapeHtml(trade.side || "buy")} · ${escapeHtml(trade.disposition)} · ${formatBnb(trade.plannedBuyBnb)}${trade.txHash ? ` · ${escapeHtml(shortAddress(trade.txHash))}` : ""}<br />
            ${escapeHtml(trade.reason)}
          </strong>
        </div>`
    )
    .join("");

  const activePortfolioCards = portfolioLifecycle.activePositions
    .slice(0, 6)
    .map(
      (position, index) => `
        <article class="candidate-card">
          <div class="candidate-card__meta">
            <span class="candidate-rank">0${index + 1}</span>
            <span class="pill ${pnlTone(position.unrealizedPnlUsd)}">${position.unrealizedPnlUsd >= 0 ? "+" : ""}${formatUsd(position.unrealizedPnlUsd)}</span>
          </div>
          <h3><a class="candidate-link" href="${candidateHref(position.tokenAddress)}">${escapeHtml(position.tokenSymbol)}</a></h3>
          <p class="candidate-subtitle">${escapeHtml(position.executionSource)} · ${escapeHtml(position.walletVerification)} · ${escapeHtml(position.state)} · ${escapeHtml(position.lastRecommendation)}</p>
          <div class="candidate-stats">
            <div><span>Initial</span><strong>${formatUsd(position.initialAllocationUsd)}</strong></div>
            <div><span>Allocated</span><strong>${formatUsd(position.allocationUsd)}</strong></div>
            <div><span>Current value</span><strong>${formatUsd(position.currentValueUsd)}</strong></div>
            <div><span>Wallet quote</span><strong>${position.walletQuoteUsd !== null && position.walletQuoteUsd !== undefined ? formatUsd(position.walletQuoteUsd) : "n/a"}</strong></div>
            <div><span>TP hit</span><strong>${position.takeProfitCount}</strong></div>
            <div><span>Unrealized</span><strong>${position.unrealizedPnlPct}%</strong></div>
            <div><span>Appearances</span><strong>${position.appearanceCount}</strong></div>
          </div>
        </article>`
    )
    .join("");

  const timelineRows = portfolioLifecycle.timeline
    .slice(0, 8)
    .map(
      (event) => `
        <div class="status-row">
          <span>${escapeHtml(event.generatedAt)}</span>
          <strong>
            ${escapeHtml(event.tokenSymbol)} · ${escapeHtml(event.type)}<br />
            ${escapeHtml(event.detail)}
          </strong>
        </div>`
    )
    .join("");

  const signalBars = [
    renderProgress(
      "Signal strength",
      snapshot.summary.averageScore,
      100,
      `${snapshot.summary.averageScore}/100`
    ),
    renderProgress(
      "Treasury deployment",
      treasurySimulation.allocatedUsd,
      treasurySimulation.paperCapitalUsd,
      `${formatUsd(treasurySimulation.allocatedUsd)}`
    ),
    renderProgress(
      "Watchlist retention",
      watchlist.filter((entry) => entry.appearances > 1).length,
      Math.max(1, watchlist.length),
      `${watchlist.filter((entry) => entry.appearances > 1).length}/${watchlist.length || 0}`
    ),
    renderProgress(
      "Goo readiness",
      gooConfigReadiness,
      3,
      `${gooConfigReadiness}/3 checks`
    ),
  ].join("");
  const overviewStateChips = [
    `execution ${escapeHtml(executionState.dryRun ? "dry-run" : "live")} / ${escapeHtml(executionState.mode)}`,
    `distribution ${escapeHtml(distributionExecution.dryRun ? "dry-run" : "live")} / ${escapeHtml(distributionPlan.selectedAsset.mode)}`,
    `goo ${escapeHtml(getDiscoveryConfig().goo.enabled ? (gooConfigReadiness === 3 ? "ready" : "warming") : "disabled")}`,
  ]
    .map((item) => `<div class="state-chip">${item}</div>`)
    .join("");
  const heroKpiCards = [
    {
      label: "Live candidates",
      value: String(snapshot.summary.candidateCount),
      meta: `${snapshot.summary.topRecommendationCount} buy-ready now`,
    },
    {
      label: "Treasury value",
      value: formatUsd(portfolioLifecycle.grossPortfolioValueUsd),
      meta: `${portfolioLifecycle.activePositions.length} active / ${portfolioLifecycle.watchPositions.length} watch`,
    },
    {
      label: "Distribution asset",
      value: escapeHtml(
        distributionPlan.selectedAsset.tokenSymbol ||
          shortAddress(distributionPlan.selectedAsset.tokenAddress || "none")
      ),
      meta: escapeHtml(distributionPlan.selectedAsset.mode),
    },
  ]
    .map(
      (item) => `
        <div class="hero-kpi-card">
          <span>${item.label}</span>
          <strong>${item.value}</strong>
          <small>${item.meta}</small>
        </div>`
    )
    .join("");
  const overviewRibbon = [
    `run ${escapeHtml(snapshot.summary.runId)}`,
    `${snapshot.summary.topRecommendationCount} buy-ready`,
    `${portfolioLifecycle.activePositions.length} active positions`,
    `${distributionPlan.eligibleHolderCount} eligible holders`,
  ]
    .map((item) => `<div class="summary-pill">${item}</div>`)
    .join("");
  const treasuryModelCards = [
    renderMetricCard("Capital model", formatUsd(treasurySimulation.paperCapitalUsd), "Current treasury capital model baseline."),
    renderMetricCard("Deployable", formatUsd(treasurySimulation.deployableCapitalUsd), "Capital currently available for new deployment."),
    renderMetricCard("Allocated", formatUsd(treasurySimulation.allocatedUsd), "Capital presently assigned inside the treasury model."),
    renderMetricCard("Dry powder", formatUsd(treasurySimulation.dryPowderUsd), "Remaining unallocated treasury capacity."),
    renderMetricCard("Reserve", `${formatUsd(treasurySimulation.reserveUsd)} / ${treasurySimulation.reservePct}%`, "Capital held back under reserve discipline."),
    renderMetricCard("Highest conviction", treasurySimulation.highestConvictionSymbol || "n/a", "Top name by current treasury conviction."),
  ].join("");
  const executionControlCards = [
    renderMetricCard("Mode", executionState.mode, `Router ${executionState.router} in ${executionState.dryRun ? "dry-run" : "live"} mode.`),
    renderMetricCard("Readiness", `${executionState.readinessScore}/${executionState.readinessTotal}`, "Current live execution readiness checks."),
    renderMetricCard("Risk cap", formatBnb(executionState.risk.maxBuyBnb), `Daily cap ${formatBnb(executionState.risk.maxDailyDeployBnb)}.`),
    renderMetricCard("Eligible lanes", String(eligibleExecutionPlans), "Candidates currently passing execution gates."),
    renderMetricCard("Cycle result", `${executionState.cycleSummary.executedCount}/${executionState.cycleSummary.dryRunCount}/${executionState.cycleSummary.failedCount}`, "Executed / dry-run / failed counts for the latest cycle."),
  ].join("");
  const distributionStateCards = [
    renderMetricCard("Holder pool", String(distributionPlan.eligibleHolderCount), `Minimum balance ${distributionPlan.minEligibleBalance}.`),
    renderMetricCard("Distribution pool", formatUsd(distributionPlan.distributionPoolUsd), `Snapshot source ${distributionPlan.snapshotSource}.`),
    renderMetricCard("Asset mode", distributionPlan.selectedAsset.mode, distributionPlan.selectedAsset.tokenSymbol || shortAddress(distributionPlan.selectedAsset.tokenAddress || "n/a")),
    renderMetricCard("Execution mode", distributionExecution.dryRun ? "dry_run" : "live", `${distributionExecution.readinessScore}/${distributionExecution.readinessTotal} readiness.`),
    renderMetricCard("Batch size", String(distributionExecution.maxRecipientsPerRun), `Pending ${Math.max(0, distributionPlan.recipients.length - distributionExecutedRecipients.size)} recipients.`),
    renderMetricCard("Fingerprint", shortAddress(distributionExecution.manifestFingerprint || "n/a"), "Current distribution campaign identity."),
  ].join("");
  const distributionRibbon = [
    `mode ${escapeHtml(distributionExecution.dryRun ? "dry_run" : "live")}`,
    `${distributionExecution.cycleSummary.dryRunCount} dry-run`,
    `${distributionExecution.cycleSummary.executedCount} executed`,
    `${Math.max(0, distributionPlan.recipients.length - distributionExecutedRecipients.size)} pending`,
  ]
    .map((item) => `<div class="summary-pill">${item}</div>`)
    .join("");
  const systemPulse = `
    <article class="glass-card section-card">
      <div class="section-title">
        <div>
          <h2>System</h2>
        </div>
      </div>
      <div class="status-panel">
        <div class="status-row"><span>Strongest candidate</span><strong>${escapeHtml(snapshot.summary.strongestCandidate?.tokenSymbol || "n/a")}</strong></div>
        <div class="status-row"><span>Strongest score</span><strong>${snapshot.summary.strongestCandidate?.score ?? "n/a"}</strong></div>
        <div class="status-row"><span>Recommendation</span><strong>${escapeHtml(snapshot.summary.strongestCandidate?.recommendation || "n/a")}</strong></div>
        <div class="status-row"><span>Goo reviewed</span><strong>${snapshot.summary.gooAgentCount}</strong></div>
        <div class="status-row"><span>Memo title</span><strong>${escapeHtml(snapshot.memoTitle)}</strong></div>
      </div>
    </article>`;

  const overviewIntelRail = `
    <div class="hero-side-stack">
      <div class="mini-panel">
        <span>Discovery</span>
        <strong>${snapshot.summary.topRecommendationCount} buy lanes</strong>
        <p>${snapshot.summary.candidateCount} scanned · avg ${snapshot.summary.averageScore}/100</p>
      </div>
      <div class="mini-panel">
        <span>Treasury</span>
        <strong>${formatUsd(portfolioLifecycle.grossPortfolioValueUsd)}</strong>
        <p>Cash ${formatUsd(portfolioLifecycle.cashBalanceUsd)} · Reserve ${formatUsd(portfolioLifecycle.reservedUsd)}</p>
      </div>
      <div class="mini-panel">
        <span>Goo</span>
        <strong>${gooConfigReadiness}/3 ready</strong>
        <p>${escapeHtml(gooReadiness.nextAction)}</p>
      </div>
    </div>`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  ${renderHeadBrandAssets("ElizaOK | elizaOK_BSC")}
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Kode+Mono:wght@400;500;700&display=swap" rel="stylesheet">
  <style>
    :root {
      color-scheme: dark;
      --bg: #16130e;
      --bg-soft: #242017;
      --panel: rgba(24, 21, 16, 0.88);
      --panel-strong: rgba(30, 27, 20, 0.94);
      --border: rgba(215, 164, 40, 0.16);
      --border-strong: rgba(240, 198, 79, 0.3);
      --text: #f4ecd2;
      --muted: #bca36d;
      --accent: #d7a428;
      --shadow: rgba(0, 0, 0, 0.55);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      height: 100vh;
      background:
        radial-gradient(circle at 18% 14%, rgba(215,164,40,0.08), transparent 18%),
        radial-gradient(circle at 82% 22%, rgba(215,164,40,0.04), transparent 16%),
        linear-gradient(180deg, #040404 0%, #080808 55%, #060606 100%);
      color: var(--text);
      font-family: "Kode Mono", monospace;
      overflow-x: hidden;
      overflow-y: hidden;
    }
    body::before {
      content: "";
      position: fixed;
      inset: 0;
      pointer-events: none;
      background-image:
        linear-gradient(rgba(215,164,40,0.018) 1px, transparent 1px),
        linear-gradient(90deg, rgba(215,164,40,0.018) 1px, transparent 1px),
        repeating-linear-gradient(180deg, rgba(255,255,255,0.018) 0 1px, transparent 1px 18px);
      background-size: 34px 34px, 34px 34px, 100% 18px;
      mask-image: linear-gradient(180deg, rgba(0,0,0,0.85), transparent);
    }
    body::after {
      content: "";
      position: fixed;
      inset: 0;
      pointer-events: none;
      background:
        radial-gradient(circle at 18% 20%, rgba(255,255,255,0.03), transparent 14%),
        radial-gradient(circle at 72% 24%, rgba(215,164,40,0.05), transparent 18%),
        radial-gradient(circle at 60% 76%, rgba(215,164,40,0.035), transparent 18%);
      animation: ambient 10s ease-in-out infinite alternate;
      opacity: 0.7;
    }
    @keyframes ambient {
      from { transform: translate3d(0,0,0) scale(1); }
      to { transform: translate3d(0,-8px,0) scale(1.02); }
    }
    .app-shell {
      position: relative;
      z-index: 1;
      display: grid;
      grid-template-columns: 272px minmax(0, 1fr);
      height: 100vh;
      overflow: hidden;
    }
    .sidebar {
      position: sticky;
      top: 0;
      align-self: start;
      min-height: 100vh;
      padding: 12px 12px 14px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      justify-content: flex-start;
      overflow: visible;
      border-right: 1px solid rgba(215,164,40,0.1);
      background:
        radial-gradient(circle at top left, rgba(255,255,255,0.03), transparent 20%),
        linear-gradient(180deg, rgba(215,164,40,0.07), transparent 18%),
        rgba(8, 8, 8, 0.96);
      backdrop-filter: blur(14px);
      box-shadow: inset -1px 0 0 rgba(255,214,10,0.05);
    }
    .app-shell::before {
      content: "// ELIZAOK :: SIGNAL_MESH :: 010110";
      position: fixed;
      right: 18px;
      bottom: 14px;
      color: rgba(244,236,210,0.14);
      font-size: 10px;
      letter-spacing: 0.18em;
      pointer-events: none;
      z-index: 0;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 4px 4px 10px;
      border-bottom: 1px solid rgba(255,214,10,0.1);
      position: relative;
    }
    .brand::after {
      content: "";
      position: absolute;
      left: 4px;
      right: 4px;
      bottom: -1px;
      height: 1px;
      background: linear-gradient(90deg, transparent, rgba(255,214,10,0.42), transparent);
      opacity: 0.85;
    }
    .brand-mark {
      width: 44px;
      height: 44px;
      border-radius: 12px;
      display: grid;
      place-items: center;
      background:
        radial-gradient(circle at 30% 30%, rgba(255,214,10,0.85), transparent 38%),
        linear-gradient(135deg, rgba(255,214,10,0.28), rgba(255,214,10,0.05));
      border: 1px solid rgba(255,214,10,0.24);
      box-shadow: 0 0 28px rgba(255,214,10,0.16), inset 0 0 0 1px rgba(255,214,10,0.08);
      overflow: hidden;
    }
    .brand-mark::after {
      content: "";
      position: absolute;
      inset: auto -12px -12px auto;
      width: 34px;
      height: 34px;
      border-radius: 50%;
      background: radial-gradient(circle, rgba(255,214,10,0.22), transparent 72%);
      pointer-events: none;
    }
    .brand-image {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }
    .brand-copy strong {
      display: block;
      font-size: 15px;
      letter-spacing: 0.08em;
      text-transform: lowercase;
      text-shadow: 0 0 18px rgba(255,214,10,0.14);
    }
    .brand-copy small {
      display: block;
      color: var(--muted);
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.15em;
      margin-top: 4px;
      opacity: 0.92;
    }
    .nav { display: none; }
    .nav-button {
      width: 100%;
      border: 1px solid transparent;
      background: rgba(255,214,10,0.02);
      color: var(--text);
      border-radius: 18px;
      padding: 14px 14px 14px 12px;
      display: flex;
      gap: 12px;
      align-items: center;
      text-align: left;
      cursor: pointer;
      transition: 180ms ease;
      position: relative;
      overflow: hidden;
      box-shadow: inset 0 0 0 1px rgba(255,214,10,0.02);
    }
    .nav-button::after {
      content: "";
      position: absolute;
      inset: 0;
      background: linear-gradient(110deg, transparent 28%, rgba(255,214,10,0.08) 50%, transparent 72%);
      transform: translateX(-120%);
      transition: transform 320ms ease;
      pointer-events: none;
    }
    .nav-button:hover,
    .nav-button.is-active {
      background: linear-gradient(90deg, rgba(255,214,10,0.14), rgba(255,214,10,0.03));
      border-color: var(--border-strong);
      transform: translateX(2px);
      box-shadow: inset 0 0 0 1px rgba(255,214,10,0.08), 0 14px 30px rgba(0,0,0,0.3);
    }
    .nav-button:hover::after,
    .nav-button.is-active::after { transform: translateX(120%); }
    .action-row {
      display: flex;
      gap: 12px;
      align-items: center;
      flex-wrap: wrap;
      margin-top: 12px;
    }
    .action-button {
      border: 1px solid rgba(255,214,10,0.38);
      background: linear-gradient(135deg, rgba(255,214,10,0.18), rgba(255,214,10,0.05));
      color: var(--text);
      border-radius: 14px;
      padding: 12px 16px;
      font-family: inherit;
      font-size: 12px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      cursor: pointer;
      transition: 160ms ease;
    }
    .action-button:hover {
      transform: translateY(-1px);
      border-color: var(--accent);
      box-shadow: 0 12px 24px rgba(0,0,0,0.28);
    }
    .action-button:disabled {
      opacity: 0.55;
      cursor: progress;
      transform: none;
    }
    .nav-index {
      color: var(--accent);
      font-size: 11px;
      letter-spacing: 0.18em;
      min-width: 26px;
    }
    .nav-glyph {
      width: 30px;
      height: 30px;
      border-radius: 10px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 14px;
      color: var(--accent);
      background: rgba(255,214,10,0.06);
      border: 1px solid rgba(255,214,10,0.1);
      box-shadow: inset 0 0 0 1px rgba(255,214,10,0.04);
    }
    .nav-copy strong {
      display: block;
      font-size: 14px;
      margin-bottom: 4px;
    }
    .nav-copy small {
      display: block;
      color: var(--muted);
      font-size: 11px;
      line-height: 1.45;
    }
    .sidebar-panels {
      display: grid;
      gap: 12px;
      margin: 18px 0 16px;
    }
    .dashboard-top-grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 16px;
    }
    .sidebar-panel {
      padding: 11px;
      border-radius: 16px;
      border: 1px solid rgba(255,214,10,0.1);
      background:
        linear-gradient(180deg, rgba(255,214,10,0.07), rgba(255,214,10,0.02)),
        rgba(11,11,11,0.84);
      box-shadow: inset 0 0 0 1px rgba(255,214,10,0.03);
      display: grid;
      gap: 8px;
    }
    .sidebar-panel__head {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .sidebar-panel__head strong,
    .sidebar-panel__title {
      display: block;
      font-size: 12px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .sidebar-panel__head small {
      display: block;
      color: var(--muted);
      font-size: 10px;
      margin-top: 2px;
    }
    .sidebar-avatar {
      width: 40px;
      height: 40px;
      border-radius: 50%;
      overflow: hidden;
      border: 1px solid rgba(255,214,10,0.18);
      background: rgba(255,214,10,0.05);
      box-shadow: 0 0 16px rgba(255,214,10,0.08);
      flex: 0 0 auto;
    }
    .sidebar-avatar__image {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }
    .sidebar-action-row {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
    }
    .sidebar-action {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 34px;
      border-radius: 10px;
      border: 1px solid rgba(255,214,10,0.16);
      background: rgba(255,214,10,0.04);
      font-size: 10px;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      transition: 180ms ease;
    }
    .sidebar-action:hover {
      border-color: var(--border-strong);
      color: var(--accent);
      transform: translateY(-1px);
    }
    .compact-status {
      gap: 8px;
    }
    .llm-model-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      color: var(--muted);
      font-size: 11px;
    }
    .llm-model-row strong {
      color: var(--text);
      font-size: 11px;
      line-height: 1.35;
      text-align: right;
    }
    .usage-stack {
      display: grid;
      gap: 7px;
    }
    .usage-row {
      display: grid;
      grid-template-columns: minmax(0, 56px) 1fr auto;
      align-items: center;
      gap: 7px;
      font-size: 10px;
      color: var(--muted);
    }
    .usage-row strong {
      color: var(--text);
      font-size: 11px;
      min-width: 34px;
      text-align: right;
    }
    .usage-meter {
      display: grid;
      grid-template-columns: repeat(10, minmax(0, 1fr));
      gap: 3px;
    }
    .usage-meter i {
      display: block;
      height: 6px;
      border-radius: 999px;
      background: rgba(255,214,10,0.08);
      border: 1px solid rgba(255,214,10,0.06);
    }
    .usage-meter i.is-on {
      background: linear-gradient(90deg, #745519, #d7a428, #f1df9a);
      border-color: rgba(255,214,10,0.18);
      box-shadow: 0 0 14px rgba(255,214,10,0.08);
    }
    .workspace {
      min-width: 0;
      height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: flex-start;
      padding: 10px 12px 14px;
      overflow: hidden;
    }
    .topbar {
      position: static;
      z-index: 4;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
      padding: 8px 10px;
      border-radius: 16px;
      border: 1px solid var(--border);
      background:
        linear-gradient(180deg, rgba(255,214,10,0.06), rgba(255,214,10,0.015)),
        rgba(12,12,12,0.82);
      backdrop-filter: blur(10px);
      box-shadow: 0 18px 48px rgba(0,0,0,0.28);
      width: min(100%, 1440px);
    }
    .topbar::after {
      content: "";
      position: absolute;
      inset: auto 18px 0;
      height: 1px;
      background: linear-gradient(90deg, transparent, rgba(255,214,10,0.45), transparent);
      opacity: 0.9;
    }
    .topbar-meta {
      display: flex;
      align-items: center;
      gap: 12px;
      flex-wrap: wrap;
    }
    .live-dot {
      width: 12px;
      height: 12px;
      border-radius: 999px;
      background: var(--accent);
      box-shadow: 0 0 18px rgba(255,214,10,0.72);
      animation: beat 1.6s ease-in-out infinite;
    }
    @keyframes beat {
      0%,100% { transform: scale(1); opacity: 0.7; }
      50% { transform: scale(1.35); opacity: 1; }
    }
    .topbar-title strong {
      display: block;
      font-size: 13px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    .topbar-title small {
      color: var(--muted);
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.12em;
    }
    .meta-chip {
      padding: 6px 9px;
      border-radius: 999px;
      background: rgba(255,214,10,0.07);
      border: 1px solid rgba(255,214,10,0.14);
      font-size: 10px;
      box-shadow: inset 0 0 0 1px rgba(255,214,10,0.03);
    }
    .social-actions {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .social-link {
      width: 34px;
      height: 34px;
      display: grid;
      place-items: center;
      border-radius: 10px;
      border: 1px solid rgba(255,214,10,0.14);
      background: rgba(255,214,10,0.04);
      transition: 180ms ease;
    }
    .social-link:hover {
      color: var(--accent);
      border-color: var(--border-strong);
      box-shadow: 0 0 24px rgba(255,214,10,0.1);
      transform: translateY(-1px);
    }
    .social-link svg { width: 16px; height: 16px; }
    .content-stack {
      width: min(100%, 1440px);
      margin-top: 10px;
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      grid-auto-rows: min-content;
      align-content: start;
      gap: 10px;
      flex: 1;
    }
    .view-panel { display: grid; gap: 10px; }
    .view-panel.is-active { display: grid; animation: fade 180ms ease; }
    @keyframes fade {
      from { opacity: 0; transform: translate3d(0,8px,0); }
      to { opacity: 1; transform: translate3d(0,0,0); }
    }
    .glass-card {
      border-radius: 28px;
      border: 1px solid var(--border);
      background:
        linear-gradient(180deg, rgba(255,214,10,0.07), rgba(255,214,10,0.015)),
        rgba(11,11,11,0.86);
      box-shadow: 0 24px 72px var(--shadow);
      overflow: hidden;
      position: relative;
      backdrop-filter: blur(10px);
    }
    .glass-card::before {
      content: "";
      position: absolute;
      inset: 0 0 auto 0;
      height: 1px;
      background: linear-gradient(90deg, transparent, rgba(255,214,10,0.4), transparent);
      opacity: 0.8;
      pointer-events: none;
    }
    .hero-card {
      padding: 14px;
      min-height: 0;
    }
    .hero-card::before {
      content: "";
      position: absolute;
      inset: -24% auto auto 64%;
      width: 180px;
      height: 180px;
      border-radius: 50%;
      background: radial-gradient(circle, rgba(255,214,10,0.18), transparent 68%);
      animation: orb 9s ease-in-out infinite alternate;
    }
    .hero-card::after {
      content: "";
      position: absolute;
      inset: 0;
      background: linear-gradient(115deg, transparent 35%, rgba(255,214,10,0.08) 50%, transparent 62%);
      transform: translateX(-100%);
      animation: scan 6s linear infinite;
      opacity: 0.28;
    }
    @keyframes orb { from { transform: translate3d(0,0,0); } to { transform: translate3d(-24px,24px,0); } }
    @keyframes scan { from { transform: translateX(-100%); } to { transform: translateX(120%); } }
    .hero-grid,
    .split-grid,
    .stats-grid,
    .signal-grid {
      display: grid;
      gap: 10px;
    }
    .hero-grid { grid-template-columns: 1.65fr 1fr; position: relative; z-index: 1; }
    .hero-side-stack {
      display: grid;
      gap: 14px;
      margin-top: 16px;
    }
    .signal-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); margin-top: 0; }
    .stats-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); }
    .split-grid { grid-template-columns: 1.4fr 1fr; }
    .eyebrow {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      color: var(--accent);
      font-size: 10px;
      letter-spacing: 0.2em;
      text-transform: uppercase;
    }
    .eyebrow::before {
      content: "";
      width: 6px;
      height: 6px;
      border-radius: 999px;
      background: var(--accent);
      box-shadow: 0 0 14px rgba(255,214,10,0.7);
    }
    h1 {
      margin: 8px 0 8px;
      font-size: clamp(24px, 3.1vw, 36px);
      line-height: 1;
      letter-spacing: -0.04em;
      max-width: none;
      text-wrap: auto;
    }
    .hero-copy,
    .section-title p,
    .candidate-thesis,
    .footer-note { color: var(--muted); }
    .hero-copy { margin: 0; font-size: 12px; line-height: 1.55; max-width: 58ch; }
    .hero-meta { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
    .state-chip {
      padding: 6px 9px;
      border-radius: 999px;
      background: rgba(255,214,10,0.09);
      border: 1px solid rgba(255,214,10,0.14);
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.12em;
      color: var(--text);
    }
    .hero-kpi-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 16px;
      margin-top: 20px;
    }
    .hero-kpi-card {
      padding: 18px 20px;
      border-radius: 20px;
      border: 1px solid rgba(255,214,10,0.12);
      background: linear-gradient(180deg, rgba(255,214,10,0.08), rgba(255,214,10,0.025));
      box-shadow: inset 0 0 0 1px rgba(255,214,10,0.04);
      position: relative;
      overflow: hidden;
    }
    .hero-kpi-card::after {
      content: "";
      position: absolute;
      inset: auto -20px -20px auto;
      width: 84px;
      height: 84px;
      border-radius: 50%;
      background: radial-gradient(circle, rgba(255,214,10,0.12), transparent 72%);
      pointer-events: none;
    }
    .hero-kpi-card:first-child {
      background:
        radial-gradient(circle at top right, rgba(255,214,10,0.16), transparent 42%),
        linear-gradient(180deg, rgba(255,214,10,0.1), rgba(255,214,10,0.03));
      border-color: rgba(255,214,10,0.2);
    }
    .hero-kpi-card span,
    .hero-kpi-card small {
      display: block;
      color: var(--muted);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.14em;
    }
    .hero-kpi-card strong {
      display: block;
      margin: 10px 0 8px;
      font-size: 24px;
      line-height: 1.1;
      color: var(--text);
    }
    .hero-kpi-card small {
      text-transform: none;
      letter-spacing: 0.04em;
      font-size: 12px;
      line-height: 1.6;
    }
    .summary-ribbon {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-top: -4px;
      padding: 16px 18px;
      border-radius: 20px;
      border: 1px solid rgba(255,214,10,0.1);
      background: linear-gradient(90deg, rgba(255,214,10,0.08), rgba(255,214,10,0.02));
      box-shadow: inset 0 0 0 1px rgba(255,214,10,0.04);
    }
    .summary-pill {
      padding: 8px 12px;
      border-radius: 999px;
      background: rgba(255,214,10,0.08);
      border: 1px solid rgba(255,214,10,0.12);
      color: var(--text);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.12em;
    }
    .section-card--accent {
      background:
        radial-gradient(circle at top right, rgba(255,214,10,0.12), transparent 32%),
        linear-gradient(180deg, rgba(255,214,10,0.08), rgba(255,214,10,0.02)),
        rgba(11,11,11,0.9);
    }
    .section-card--dense .status-panel,
    .section-card--dense .section-stack {
      gap: 10px;
    }
    .section-card--spotlight {
      background:
        radial-gradient(circle at 12% 14%, rgba(255,214,10,0.11), transparent 24%),
        linear-gradient(180deg, rgba(255,214,10,0.07), rgba(255,214,10,0.018)),
        rgba(11,11,11,0.88);
    }
    .snapshot-grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 14px;
      margin-top: 10px;
    }
    .feature-dock-grid {
      display: grid;
      grid-template-columns: repeat(5, minmax(0, 1fr));
      gap: 10px;
    }
    .feature-dock-card {
      display: grid;
      gap: 6px;
      padding: 10px;
      border-radius: 16px;
      border: 1px solid rgba(255,214,10,0.1);
      background: rgba(255,214,10,0.04);
      transition: 180ms ease;
    }
    .feature-dock-card:hover {
      transform: translateY(-2px);
      border-color: rgba(255,214,10,0.18);
      box-shadow: 0 16px 36px rgba(0,0,0,0.22);
    }
    .feature-dock-card--hot {
      background:
        radial-gradient(circle at top right, rgba(255,214,10,0.14), transparent 42%),
        rgba(255,214,10,0.04);
    }
    .feature-dock-card--warm {
      background:
        radial-gradient(circle at top right, rgba(255,214,10,0.08), transparent 38%),
        rgba(255,214,10,0.03);
    }
    .feature-dock-card__top,
    .feature-dock-card span,
    .feature-dock-card small,
    .feature-dock-card em {
      display: block;
    }
    .feature-dock-card__top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
    }
    .feature-dock-card span {
      color: var(--muted);
      font-size: 11px;
      letter-spacing: 0.14em;
      text-transform: uppercase;
    }
    .feature-dock-card strong {
      font-size: 16px;
      line-height: 1.05;
    }
    .feature-dock-card small {
      color: var(--muted);
      font-size: 10px;
      line-height: 1.35;
    }
    .feature-dock-card em {
      color: var(--text);
      font-style: normal;
      font-size: 10px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      padding: 3px 7px;
      border-radius: 999px;
      border: 1px solid rgba(255,214,10,0.14);
      background: rgba(255,214,10,0.08);
    }
    .feature-dock-card__track {
      height: 5px;
      border-radius: 999px;
      background: rgba(255,214,10,0.08);
      overflow: hidden;
      margin-top: 2px;
    }
    .feature-dock-card__fill {
      height: 100%;
      border-radius: inherit;
      background: linear-gradient(90deg, #745519, #d7a428, #f1df9a);
      box-shadow: 0 0 14px rgba(255,214,10,0.28);
    }
    .fold-section {
      border-radius: 16px;
      border: 1px solid rgba(255,214,10,0.1);
      background:
        linear-gradient(180deg, rgba(255,214,10,0.06), rgba(255,214,10,0.02)),
        rgba(11,11,11,0.86);
      overflow: hidden;
      box-shadow: 0 12px 28px rgba(0,0,0,0.18);
    }
    .fold-summary {
      list-style: none;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 10px 12px;
      cursor: pointer;
    }
    .fold-summary::-webkit-details-marker {
      display: none;
    }
    .fold-summary strong {
      font-size: 13px;
      letter-spacing: 0.04em;
    }
    .fold-summary span {
      color: var(--muted);
      font-size: 11px;
      line-height: 1.35;
      flex: 1;
      text-align: right;
    }
    .fold-summary::after {
      content: "+";
      color: var(--accent);
      font-size: 15px;
      line-height: 1;
    }
    .fold-section[open] .fold-summary::after {
      content: "−";
    }
    .fold-body {
      padding: 0 12px 12px;
      border-top: 1px solid rgba(255,214,10,0.08);
    }
    .snapshot-tile {
      padding: 10px 12px;
      border-radius: 14px;
      border: 1px solid rgba(255,214,10,0.1);
      background: rgba(255,214,10,0.04);
    }
    .snapshot-tile span {
      display: block;
      color: var(--muted);
      font-size: 11px;
      letter-spacing: 0.14em;
      text-transform: uppercase;
    }
    .snapshot-tile strong {
      display: block;
      margin-top: 8px;
      font-size: 17px;
      line-height: 1.1;
    }
    .profile-label {
      display: inline-flex;
      align-items: center;
      padding: 8px 12px;
      border-radius: 999px;
      border: 1px solid rgba(255,214,10,0.14);
      background: rgba(255,214,10,0.06);
      color: var(--accent);
      font-size: 12px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      margin-bottom: 16px;
    }
    .radar-box {
      min-height: 100%;
      display: grid;
      place-items: center;
      padding: 24px;
    }
    .radar {
      width: min(240px, 100%);
      aspect-ratio: 1;
      position: relative;
      border-radius: 50%;
      border: 1px solid rgba(255,214,10,0.18);
      background:
        radial-gradient(circle, rgba(255,214,10,0.12), transparent 52%),
        repeating-radial-gradient(circle, rgba(255,214,10,0.08) 0 1px, transparent 1px 34px);
      box-shadow: inset 0 0 42px rgba(255,214,10,0.08);
    }
    .radar::before,
    .radar::after {
      content: "";
      position: absolute;
      inset: 50%;
      transform: translate(-50%, -50%);
      background: rgba(255,214,10,0.12);
    }
    .radar::before { width: 1px; height: 100%; }
    .radar::after { width: 100%; height: 1px; }
    .radar-sweep {
      position: absolute;
      inset: 0;
      border-radius: 50%;
      background: conic-gradient(from 0deg, rgba(255,214,10,0), rgba(255,214,10,0.2), rgba(255,214,10,0));
      animation: spin 4.8s linear infinite;
      mask-image: radial-gradient(circle at center, transparent 18%, black 64%);
    }
    .radar-core {
      position: absolute;
      inset: 50%;
      width: 18px;
      height: 18px;
      transform: translate(-50%, -50%);
      border-radius: 50%;
      background: var(--accent);
      box-shadow: 0 0 22px rgba(255,214,10,0.75);
    }
    .radar-label {
      position: absolute;
      left: 50%;
      bottom: 18px;
      transform: translateX(-50%);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.14em;
      color: var(--muted);
    }
    @keyframes spin { from { transform: rotate(0); } to { transform: rotate(360deg); } }
    .progress-card,
    .section-card,
    .stat-card,
    .candidate-card,
    .goo-card {
      position: relative;
      overflow: hidden;
      transition: transform 180ms ease, border-color 180ms ease, box-shadow 180ms ease, background 180ms ease;
    }
    .progress-card,
    .candidate-card,
    .goo-card {
      border-radius: 18px;
      border: 1px solid rgba(255,214,10,0.12);
      background: linear-gradient(180deg, rgba(255,214,10,0.05), rgba(255,214,10,0.02));
    }
    .progress-card { padding: 12px 14px; }
    .progress-head {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 8px;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.14em;
      color: var(--muted);
    }
    .progress-head strong { color: var(--text); font-size: 11px; }
    .progress-track {
      height: 8px;
      border-radius: 999px;
      background: rgba(255,214,10,0.08);
      overflow: hidden;
    }
    .progress-fill {
      height: 100%;
      border-radius: inherit;
      background: linear-gradient(90deg, #745519, #d7a428, #f1df9a);
      box-shadow: 0 0 18px rgba(255,214,10,0.42);
    }
    .progress-card { padding: 8px 10px; }
    .stat-card { padding: 14px; min-height: 122px; }
    .stat-card:hover,
    .candidate-card:hover,
    .goo-card:hover,
    .section-card:hover {
      transform: translateY(-3px);
      border-color: var(--border-strong);
      box-shadow: 0 30px 84px rgba(0,0,0,0.38);
    }
    .stat-card span,
    .candidate-stats span,
    .status-row span {
      display: block;
      color: var(--muted);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.14em;
      margin-bottom: 6px;
    }
    .stat-card strong {
      display: block;
      font-size: 24px;
      line-height: 1;
      margin: 10px 0 12px;
    }
    .stat-card p { margin: 0; color: var(--muted); font-size: 11px; line-height: 1.45; }
    .section-card { padding: 12px; }
    .section-title {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
      margin-bottom: 12px;
      position: relative;
    }
    .section-title::after {
      content: "";
      position: absolute;
      left: 0;
      right: 0;
      bottom: -6px;
      height: 1px;
      background: linear-gradient(90deg, rgba(255,214,10,0.22), transparent 72%);
      opacity: 0.75;
    }
    .section-heading {
      display: flex;
      align-items: flex-start;
      gap: 12px;
    }
    .section-icon {
      width: 26px;
      height: 26px;
      border-radius: 9px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      color: var(--accent);
      background: rgba(255,214,10,0.08);
      border: 1px solid rgba(255,214,10,0.12);
      box-shadow: inset 0 0 0 1px rgba(255,214,10,0.05);
      font-size: 11px;
      flex-shrink: 0;
      margin-top: 2px;
    }
    .section-title h2 { margin: 0; font-size: 16px; letter-spacing: -0.02em; }
    .section-title p { margin: 4px 0 0; font-size: 11px; line-height: 1.45; max-width: 68ch; }
    .section-stack { display: grid; gap: 10px; }
    .metric-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 10px;
    }
    .metric-card {
      padding: 10px;
      border-radius: 14px;
      border: 1px solid rgba(255,214,10,0.1);
      background: linear-gradient(180deg, rgba(255,214,10,0.08), rgba(255,214,10,0.025));
      box-shadow: inset 0 0 0 1px rgba(255,214,10,0.04);
      transition: transform 180ms ease, border-color 180ms ease, box-shadow 180ms ease;
    }
    .metric-card:hover {
      transform: translateY(-2px);
      border-color: rgba(255,214,10,0.18);
      box-shadow: inset 0 0 0 1px rgba(255,214,10,0.05), 0 18px 44px rgba(0,0,0,0.22);
    }
    .metric-card span {
      display: block;
      color: var(--muted);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.14em;
      margin-bottom: 7px;
    }
    .metric-card strong {
      display: block;
      font-size: 15px;
      line-height: 1.1;
      margin-bottom: 6px;
      color: var(--text);
    }
    .metric-card p {
      margin: 0;
      color: var(--muted);
      font-size: 10px;
      line-height: 1.4;
    }
    .mini-panel {
      padding: 14px 16px;
      border-radius: 18px;
      border: 1px solid rgba(255,214,10,0.1);
      background: linear-gradient(180deg, rgba(255,214,10,0.08), rgba(255,214,10,0.03));
      box-shadow: inset 0 0 0 1px rgba(255,214,10,0.04);
    }
    .mini-panel span {
      display: block;
      color: var(--muted);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.14em;
      margin-bottom: 8px;
    }
    .mini-panel strong {
      display: block;
      font-size: 16px;
      line-height: 1.45;
      margin-bottom: 8px;
    }
    .mini-panel p {
      margin: 0;
      font-size: 12px;
      line-height: 1.75;
    }
    .candidate-card,
    .goo-card { padding: 10px; }
    .candidate-card::after,
    .goo-card::after {
      content: "";
      position: absolute;
      inset: auto -40px -40px auto;
      width: 120px;
      height: 120px;
      border-radius: 50%;
      background: radial-gradient(circle, rgba(255,214,10,0.12), transparent 72%);
    }
    .candidate-card::before,
    .goo-card::before,
    .stat-card::before {
      content: "";
      position: absolute;
      left: 18px;
      right: 18px;
      top: 0;
      height: 1px;
      background: linear-gradient(90deg, transparent, rgba(255,214,10,0.5), transparent);
      opacity: 0.85;
    }
    .candidate-card,
    .goo-card {
      box-shadow: inset 0 0 0 1px rgba(255,214,10,0.03);
    }
    .candidate-card__meta {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
      margin-bottom: 10px;
    }
    .candidate-rank {
      color: var(--accent);
      font-size: 11px;
      letter-spacing: 0.18em;
    }
    .pill {
      display: inline-flex;
      align-items: center;
      padding: 5px 8px;
      border-radius: 999px;
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.16em;
      border: 1px solid transparent;
    }
    .tone-hot { color: #171100; background: var(--accent); }
    .tone-warm { color: #1a1200; background: rgba(255,214,10,0.72); }
    .tone-cool {
      color: var(--text);
      background: rgba(255,214,10,0.08);
      border-color: rgba(255,214,10,0.16);
    }
    .candidate-card h3,
    .goo-card h3 { margin: 0 0 6px; font-size: 15px; letter-spacing: -0.02em; }
    .candidate-link,
    .watchlist-link { color: inherit; }
    .candidate-link:hover,
    .watchlist-link:hover { color: var(--accent); }
    .candidate-subtitle { margin: 0 0 10px; color: var(--muted); font-size: 10px; line-height: 1.45; }
    .candidate-stats {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
      margin-bottom: 6px;
    }
    .candidate-stats div {
      padding: 7px 8px;
      border-radius: 10px;
      background: rgba(255,214,10,0.05);
      border: 1px solid rgba(255,214,10,0.08);
    }
    .candidate-stats strong { font-size: 12px; line-height: 1.35; }
    .candidate-thesis { margin: 0; font-size: 11px; line-height: 1.5; }
    .status-panel { display: grid; gap: 8px; }
    .status-row {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      padding: 7px 9px;
      border-radius: 10px;
      background: rgba(255,214,10,0.05);
      border: 1px solid rgba(255,214,10,0.1);
      transition: transform 160ms ease, border-color 160ms ease, background 160ms ease;
      box-shadow: inset 0 0 0 1px rgba(255,214,10,0.025);
    }
    .status-row:hover {
      transform: translateX(2px);
      border-color: rgba(255,214,10,0.18);
      background: rgba(255,214,10,0.07);
    }
    .status-row strong { text-align: right; font-size: 11px; line-height: 1.35; }
    .footer-note { margin-top: 10px; font-size: 10px; line-height: 1.45; }
    .footer-note code { color: var(--text); word-break: break-all; }
    .content-stack > .view-panel[data-view-panel="overview"] {
      grid-column: 1 / -1;
    }
    .content-stack > .fold-section {
      min-height: 0;
    }
    body:has(.fold-section[open]) {
      height: auto;
      overflow-y: auto;
    }
    body:has(.fold-section[open]) .app-shell {
      height: auto;
      overflow: visible;
    }
    body:has(.fold-section[open]) .workspace {
      height: auto;
      overflow: visible;
    }
    body:has(.fold-section[open]) .content-stack {
      grid-template-columns: 1fr;
    }
    body:has(.fold-section[open]) .content-stack > .view-panel[data-view-panel="overview"] {
      display: none;
    }
    body:has(.fold-section[open]) .content-stack > .fold-section:not([open]) {
      display: none;
    }
    body:has(.fold-section[open]) .content-stack > .fold-section[open] {
      grid-column: 1 / -1;
    }
    .view-panel[data-view-panel="overview"] {
      grid-template-columns: minmax(0, 1.15fr) minmax(340px, 0.85fr);
      align-items: start;
    }
    .view-panel[data-view-panel="overview"] > .hero-card {
      grid-column: 1;
      grid-row: 1;
    }
    .view-panel[data-view-panel="overview"] > .feature-dock-grid {
      grid-column: 1 / span 2;
      grid-row: 2;
    }
    .view-panel[data-view-panel="overview"] > .section-card {
      grid-column: 2;
      grid-row: 1;
    }
    code {
      transition: border-color 180ms ease, box-shadow 180ms ease, background 180ms ease;
    }
    code:hover {
      border-color: rgba(255,214,10,0.18);
      box-shadow: 0 0 18px rgba(255,214,10,0.08);
      background: rgba(255,214,10,0.06);
    }
    @media (max-width: 1200px) {
      .content-stack {
        grid-template-columns: 1fr;
      }
      .view-panel[data-view-panel="overview"] {
        grid-template-columns: 1fr;
      }
      .view-panel[data-view-panel="overview"] > .hero-card,
      .view-panel[data-view-panel="overview"] > .feature-dock-grid,
      .view-panel[data-view-panel="overview"] > .section-card {
        grid-column: auto;
        grid-row: auto;
      }
      .hero-grid,
      .split-grid,
      .signal-grid,
      .stats-grid,
      .hero-kpi-grid,
      .feature-dock-grid,
      .metric-grid { grid-template-columns: 1fr; }
    }
    @media (max-width: 980px) {
      body { height: auto; overflow-y: auto; }
      .app-shell { grid-template-columns: 1fr; height: auto; overflow: visible; }
      .sidebar {
        position: static;
        min-height: auto;
        justify-content: flex-start;
        border-right: 0;
        border-bottom: 1px solid rgba(255,214,10,0.08);
      }
      .workspace { height: auto; overflow: visible; padding-top: 12px; }
      .topbar { position: static; }
    }
    @media (max-width: 720px) {
      .workspace,
      .sidebar { padding-left: 14px; padding-right: 14px; }
      .topbar { flex-direction: column; align-items: flex-start; }
      .social-actions { width: 100%; justify-content: flex-end; }
    }
  </style>
</head>
<body>
  <div class="app-shell">
    <aside class="sidebar">
      ${sidebarMasterCard}
    </aside>

    <div class="workspace">
      <header class="topbar">
        <div class="topbar-meta">
          <div class="live-dot" aria-hidden="true"></div>
          <div class="topbar-title">
            <strong id="view-title">Overview</strong>
            <small id="view-subtitle"></small>
          </div>
          <div class="meta-chip">Generated ${escapeHtml(snapshot.generatedAt)}</div>
          <div class="meta-chip">Run ${escapeHtml(snapshot.summary.runId)}</div>
        </div>
        <div class="social-actions">
          <a class="social-link" href="https://github.com/elizaokbsc" target="_blank" rel="noreferrer" aria-label="GitHub">
            ${renderGithubIconSvg()}
          </a>
          <a class="social-link" href="https://x.com/elizaok_bsc" target="_blank" rel="noreferrer" aria-label="X">
            ${renderXIconSvg()}
          </a>
        </div>
      </header>

      <main class="content-stack">
        <section class="view-panel is-active" data-view-panel="overview" data-view-label="Overview" data-view-subtitle="">
          <article class="glass-card hero-card">
            <div class="eyebrow">dashboard</div>
            <h1>elizaok agent</h1>
            <div class="hero-meta">${overviewStateChips}</div>
            <div class="snapshot-grid">${snapshotStatTiles}</div>
          </article>
          <section class="feature-dock-grid">
            ${featureDockCards}
          </section>
          <article class="glass-card section-card section-card--dense">
            <div class="section-title"><div><h2>Live Signals</h2></div></div>
            <div class="profile-label">${escapeHtml(riskProfile)}</div>
            <div class="signal-grid">${overviewVisualBars}</div>
          </article>
        </section>

        <details class="fold-section" id="discovery-section">
          <summary class="fold-summary"><strong>Discovery</strong><span>${escapeHtml(discoveryFoldSummary)}</span></summary>
          <div class="fold-body">
            <section class="view-panel" data-view-panel="discovery" data-view-label="Discovery" data-view-subtitle="">
              <section class="split-grid">
                <article class="glass-card section-card">
                  <div class="section-title"><div><h2>Discovery Feed</h2></div></div>
                  <div class="section-stack">${topCandidates || "<p class=\"candidate-thesis\">No data.</p>"}</div>
                </article>
                ${systemPulse}
              </section>
              <article class="glass-card section-card">
                <div class="section-title"><div><h2>Recent Runs</h2></div></div>
                <div class="status-panel">${recentRuns || "<p class=\"candidate-thesis\">No data.</p>"}</div>
              </article>
            </section>
          </div>
        </details>

        <details class="fold-section" id="portfolio-section">
          <summary class="fold-summary"><strong>Portfolio</strong><span>${escapeHtml(portfolioFoldSummary)}</span></summary>
          <div class="fold-body">
        <section class="view-panel" data-view-panel="portfolio" data-view-label="Portfolio" data-view-subtitle="">
          <section class="split-grid">
            <article class="glass-card section-card">
              <div class="section-title"><div class="section-heading"><span class="section-icon">▣</span><div><h2>Lifecycle</h2></div></div></div>
              <div class="status-panel">
                <div class="status-row"><span>Active positions</span><strong>${portfolioLifecycle.activePositions.length}</strong></div>
                <div class="status-row"><span>Watch positions</span><strong>${portfolioLifecycle.watchPositions.length}</strong></div>
                <div class="status-row"><span>Exited positions</span><strong>${portfolioLifecycle.exitedPositions.length}</strong></div>
                <div class="status-row"><span>Treasury cash</span><strong>${formatUsd(portfolioLifecycle.cashBalanceUsd)}</strong></div>
                <div class="status-row"><span>Reserved</span><strong>${formatUsd(portfolioLifecycle.reservedUsd)}</strong></div>
                <div class="status-row"><span>Gross treasury</span><strong>${formatUsd(portfolioLifecycle.grossPortfolioValueUsd)}</strong></div>
                <div class="status-row"><span>Current value</span><strong>${formatUsd(portfolioLifecycle.totalCurrentValueUsd)}</strong></div>
                <div class="status-row"><span>Realized PnL</span><strong>${portfolioLifecycle.totalRealizedPnlUsd >= 0 ? "+" : ""}${formatUsd(portfolioLifecycle.totalRealizedPnlUsd)}</strong></div>
              </div>
            </article>
            <article class="glass-card section-card">
              <div class="section-title"><div class="section-heading"><span class="section-icon">≋</span><div><h2>Timeline</h2></div></div></div>
              <div class="status-panel">${timelineRows || "<p class=\"candidate-thesis\">No data.</p>"}</div>
            </article>
          </section>
          <section class="split-grid">
            <article class="glass-card section-card">
              <div class="section-title"><div><h2>Active Positions</h2></div></div>
              <div class="section-stack">${activePortfolioCards || "<p class=\"candidate-thesis\">No data.</p>"}</div>
            </article>
            <article class="glass-card section-card">
              <div class="section-title"><div><h2>Watchlist</h2></div></div>
              <div class="status-panel">${watchlistRows || "<p class=\"candidate-thesis\">No data.</p>"}</div>
            </article>
          </section>
        </section>
          </div>
        </details>

        <details class="fold-section" id="treasury-section">
          <summary class="fold-summary"><strong>Treasury</strong><span>${escapeHtml(treasuryFoldSummary)}</span></summary>
          <div class="fold-body">
        <section class="view-panel" data-view-panel="treasury" data-view-label="Treasury" data-view-subtitle="">
          <section class="split-grid">
            <article class="glass-card section-card">
              <div class="section-title"><div class="section-heading"><span class="section-icon">◌</span><div><h2>Treasury</h2></div></div></div>
              <div class="metric-grid">${treasuryModelCards}</div>
            </article>
            <article class="glass-card section-card">
              <div class="section-title"><div class="section-heading"><span class="section-icon">✦</span><div><h2>Rules</h2></div></div></div>
              <div class="status-panel">
                <div class="status-row"><span>Take-profit rule set</span><strong>${escapeHtml(takeProfitSummary)}</strong></div>
                <div class="status-row"><span>Stop loss</span><strong>${treasuryRules.stopLossPct}%</strong></div>
                <div class="status-row"><span>Force-exit score</span><strong>${treasuryRules.exitScoreThreshold}</strong></div>
                <div class="status-row"><span>Max active positions</span><strong>${treasuryRules.maxActivePositions}</strong></div>
              </div>
            </article>
          </section>
          <section class="split-grid">
            <article class="glass-card section-card">
              <div class="section-title"><div class="section-heading"><span class="section-icon">⌁</span><div><h2>Execution</h2></div></div></div>
              <div class="metric-grid">${executionControlCards}</div>
            </article>
            <article class="glass-card section-card">
              <div class="section-title"><div class="section-heading"><span class="section-icon">⊛</span><div><h2>Execution Gates</h2></div></div></div>
              <div class="status-panel">${executionPlanRows || "<p class=\"candidate-thesis\">No data.</p>"}</div>
            </article>
          </section>
          <section class="split-grid">
            <article class="glass-card section-card">
              <div class="section-title"><div class="section-heading"><span class="section-icon">⋄</span><div><h2>Trade Ledger</h2></div></div></div>
              <div class="status-panel">
                <div class="status-row"><span>Total executed</span><strong>${formatBnb(tradeLedger.totalExecutedBnb)}</strong></div>
                <div class="status-row"><span>Total dry-run</span><strong>${formatBnb(tradeLedger.totalDryRunBnb)}</strong></div>
                <div class="status-row"><span>Ledger entries</span><strong>${tradeLedger.records.length}</strong></div>
                <div class="status-row"><span>Last updated</span><strong>${escapeHtml(tradeLedger.lastUpdatedAt || "n/a")}</strong></div>
              </div>
            </article>
            <article class="glass-card section-card">
              <div class="section-title"><div class="section-heading"><span class="section-icon">≣</span><div><h2>Recent Trades</h2></div></div></div>
              <div class="status-panel">${recentTradeRows || "<p class=\"candidate-thesis\">No data.</p>"}</div>
            </article>
          </section>
          <article class="glass-card section-card">
            <div class="section-title"><div><h2>Allocations</h2></div></div>
            <div class="section-stack">${treasuryAllocationCards || "<p class=\"candidate-thesis\">No data.</p>"}</div>
          </article>
        </section>
          </div>
        </details>

        <details class="fold-section" id="distribution-section">
          <summary class="fold-summary"><strong>Distribution</strong><span>${escapeHtml(distributionFoldSummary)}</span></summary>
          <div class="fold-body">
        <section class="view-panel" data-view-panel="distribution" data-view-label="Distribution" data-view-subtitle="">
          <div class="summary-ribbon">${distributionRibbon}</div>
          <section class="split-grid">
            <article class="glass-card section-card section-card--accent">
              <div class="section-title"><div><h2>State</h2></div></div>
              <div class="metric-grid">${distributionStateCards}</div>
            </article>
            <article class="glass-card section-card section-card--spotlight">
              <div class="section-title"><div><h2>Recipients</h2></div></div>
              <div class="section-stack">${distributionRecipients || "<p class=\"candidate-thesis\">No data.</p>"}</div>
            </article>
          </section>
          <section class="split-grid">
            <article class="glass-card section-card section-card--dense">
              <div class="section-title"><div><h2>Manual Run</h2></div></div>
              <div class="status-panel">
                <div class="status-row"><span>Endpoint</span><strong>/api/elizaok/distribution/run</strong></div>
                <div class="status-row"><span>Method</span><strong>POST</strong></div>
                <div class="status-row"><span>Mode</span><strong>${distributionExecution.dryRun ? "Dry-run safe" : "Live sender armed"}</strong></div>
              </div>
              <div class="action-row">
                <button class="action-button" type="button" data-distribution-run>Run Distribution Now</button>
                <span class="footer-note" id="distribution-run-status">Idle.</span>
              </div>
            </article>
            <article class="glass-card section-card section-card--dense">
              <div class="section-title"><div><h2>Manual Trigger</h2></div></div>
              <div class="status-panel">
                <div class="status-row"><span>Rebuilds plan</span><strong>Yes</strong></div>
                <div class="status-row"><span>Writes snapshot</span><strong>Yes</strong></div>
                <div class="status-row"><span>Uses current env</span><strong>Yes</strong></div>
                <div class="status-row"><span>Skips prior live recipients</span><strong>Yes, by campaign fingerprint</strong></div>
              </div>
            </article>
          </section>
          <section class="split-grid">
            <article class="glass-card section-card section-card--spotlight">
              <div class="section-title"><div><h2>Execution</h2></div></div>
              <div class="status-panel">
                <div class="status-row"><span>Enabled</span><strong>${distributionExecution.enabled ? "Yes" : "No"}</strong></div>
                <div class="status-row"><span>Mode</span><strong>${distributionExecution.dryRun ? "dry_run" : "live"}</strong></div>
                <div class="status-row"><span>Readiness</span><strong>${distributionExecution.readinessScore}/${distributionExecution.readinessTotal}</strong></div>
                <div class="status-row"><span>Asset token</span><strong>${escapeHtml(shortAddress(distributionExecution.assetTokenAddress || "n/a"))}</strong></div>
                <div class="status-row"><span>Total amount</span><strong>${escapeHtml(distributionExecution.assetTotalAmount || "n/a")}</strong></div>
                <div class="status-row"><span>Batch size</span><strong>${distributionExecution.maxRecipientsPerRun}</strong></div>
                <div class="status-row"><span>Verified wallet</span><strong>${getDiscoveryConfig().distribution.execution.requireVerifiedWallet ? "required" : "optional"}</strong></div>
                <div class="status-row"><span>Positive PnL</span><strong>${getDiscoveryConfig().distribution.execution.requirePositivePnl ? "required" : "optional"}</strong></div>
                <div class="status-row"><span>Min wallet quote</span><strong>${formatUsd(getDiscoveryConfig().distribution.execution.minWalletQuoteUsd)}</strong></div>
                <div class="status-row"><span>Min portfolio share</span><strong>${getDiscoveryConfig().distribution.execution.minPortfolioSharePct}%</strong></div>
                <div class="status-row"><span>Manifest fingerprint</span><strong>${escapeHtml(shortAddress(distributionExecution.manifestFingerprint || "n/a"))}</strong></div>
                <div class="status-row"><span>Next action</span><strong>${escapeHtml(distributionExecution.nextAction)}</strong></div>
              </div>
            </article>
            <article class="glass-card section-card section-card--dense">
              <div class="section-title"><div><h2>Checklist</h2></div></div>
              <div class="status-panel">${distributionExecutionRows || "<p class=\"candidate-thesis\">No data.</p>"}</div>
            </article>
          </section>
          <section class="split-grid">
            <article class="glass-card section-card section-card--accent">
              <div class="section-title"><div><h2>Ledger</h2></div></div>
              <div class="status-panel">
                <div class="status-row"><span>Total live sent</span><strong>${distributionLedger.totalRecipientsExecuted}</strong></div>
                <div class="status-row"><span>Total dry-run</span><strong>${distributionLedger.totalRecipientsDryRun}</strong></div>
                <div class="status-row"><span>Last updated</span><strong>${escapeHtml(distributionLedger.lastUpdatedAt || "n/a")}</strong></div>
                <div class="status-row"><span>Cycle summary</span><strong>${distributionExecution.cycleSummary.executedCount} executed / ${distributionExecution.cycleSummary.dryRunCount} dry-run / ${distributionExecution.cycleSummary.failedCount} failed</strong></div>
              </div>
            </article>
            <article class="glass-card section-card section-card--dense">
              <div class="section-title"><div><h2>Recent Events</h2></div></div>
              <div class="status-panel">${distributionLedgerRows || "<p class=\"candidate-thesis\">No data.</p>"}</div>
            </article>
          </section>
          <section class="split-grid">
            <article class="glass-card section-card section-card--spotlight">
              <div class="section-title"><div><h2>Next Batch</h2></div></div>
              <div class="status-panel">${distributionPendingRows || "<p class=\"candidate-thesis\">No data.</p>"}</div>
            </article>
            <article class="glass-card section-card section-card--dense">
              <div class="section-title"><div><h2>Resume</h2></div></div>
              <div class="status-panel">
                <div class="status-row"><span>Current fingerprint</span><strong>${escapeHtml(shortAddress(distributionExecution.manifestFingerprint || "n/a"))}</strong></div>
                <div class="status-row"><span>Executed recipients</span><strong>${distributionExecutedRecipients.size}</strong></div>
                <div class="status-row"><span>Pending recipients</span><strong>${Math.max(0, distributionPlan.recipients.length - distributionExecutedRecipients.size)}</strong></div>
                <div class="status-row"><span>Resume rule</span><strong>Executed recipients for the current fingerprint are skipped automatically.</strong></div>
              </div>
            </article>
          </section>
        </section>
          </div>
        </details>

        <details class="fold-section" id="goo-section">
          <summary class="fold-summary"><strong>Goo</strong><span>${escapeHtml(gooFoldSummary)}</span></summary>
          <div class="fold-body">
        <section class="view-panel" data-view-panel="goo" data-view-label="Goo Operator" data-view-subtitle="">
          <section class="split-grid">
            <article class="glass-card section-card">
              <div class="section-title"><div class="section-heading"><span class="section-icon">◎</span><div><h2>Goo Status</h2></div></div></div>
              <div class="status-panel">
                <div class="status-row"><span>Enabled</span><strong>${getDiscoveryConfig().goo.enabled ? "Yes" : "No"}</strong></div>
                <div class="status-row"><span>Configured</span><strong>${gooConfigReadiness === 3 ? "Ready for live scan" : "Awaiting RPC + registry"}</strong></div>
                <div class="status-row"><span>Readiness</span><strong>${gooConfigReadiness}/3 checks complete</strong></div>
                <div class="status-row"><span>Next action</span><strong>${escapeHtml(gooReadiness.nextAction)}</strong></div>
                <div class="status-row"><span>Reviewed</span><strong>${snapshot.summary.gooAgentCount}</strong></div>
                <div class="status-row"><span>Priority targets</span><strong>${snapshot.summary.gooPriorityCount}</strong></div>
                <div class="status-row"><span>Best candidate</span><strong>${escapeHtml(snapshot.summary.strongestGooCandidate?.agentId || "n/a")}</strong></div>
              </div>
            </article>
            <article class="glass-card section-card">
              <div class="section-title"><div class="section-heading"><span class="section-icon">◍</span><div><h2>Readiness</h2></div></div></div>
              <div class="status-panel">
                ${gooReadiness.checklist
                  .map(
                    (item) => `
                      <div class="status-row">
                        <span>${escapeHtml(item.label)}</span>
                        <strong>${item.done ? "READY" : "TODO"}<br />${escapeHtml(item.detail)}</strong>
                      </div>`
                  )
                  .join("")}
              </div>
            </article>
          </section>
          <section class="split-grid">
            <article class="glass-card section-card">
              <div class="section-title"><div class="section-heading"><span class="section-icon">◈</span><div><h2>Queue</h2></div></div></div>
              <div class="status-panel">${gooQueueRows || "<p class=\"candidate-thesis\">No data.</p>"}</div>
            </article>
            <article class="glass-card section-card">
              <div class="section-title"><div class="section-heading"><span class="section-icon">◔</span><div><h2>Candidates</h2></div></div></div>
              <div class="section-stack">${gooCandidates || "<p class=\"candidate-thesis\">No data.</p>"}</div>
            </article>
          </section>
        </section>
          </div>
        </details>

      </main>
    </div>
  </div>
  <script>
    (function () {
      var distributionRunButton = document.querySelector("[data-distribution-run]");
      var distributionRunStatus = document.getElementById("distribution-run-status");
      if (distributionRunButton) {
        distributionRunButton.addEventListener("click", function () {
          distributionRunButton.disabled = true;
          if (distributionRunStatus) distributionRunStatus.textContent = "Running manual distribution...";
          fetch("/api/elizaok/distribution/run", { method: "POST" })
            .then(function (response) { return response.json(); })
            .then(function (payload) {
              if (distributionRunStatus) {
                distributionRunStatus.textContent = payload && payload.message
                  ? payload.message
                  : "Manual distribution run completed.";
              }
              window.setTimeout(function () { window.location.reload(); }, 800);
            })
            .catch(function (error) {
              if (distributionRunStatus) distributionRunStatus.textContent = "Manual run failed: " + error;
              distributionRunButton.disabled = false;
            });
        });
      }
    })();
  </script>
</body>
</html>`;
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  runtime: AgentRuntime
): Promise<void> {
  const config = getDiscoveryConfig();
  const snapshot = getLatestSnapshot() || (await loadSnapshotFromDisk(config.reportsDir));
  const recentHistory = snapshot?.recentHistory ?? [];
  const treasurySimulation = snapshot?.treasurySimulation ?? {
    paperCapitalUsd: 0,
    deployableCapitalUsd: 0,
    allocatedUsd: 0,
    dryPowderUsd: 0,
    reserveUsd: 0,
    reservePct: 0,
    positionCount: 0,
    averagePositionUsd: 0,
    highestConvictionSymbol: undefined,
    strategyNote: "Treasury simulation will appear after the next completed scan.",
    positions: [],
  };
  const portfolioLifecycle = snapshot?.portfolioLifecycle ?? {
    activePositions: [],
    watchPositions: [],
    exitedPositions: [],
    timeline: [],
    cashBalanceUsd: 0,
    grossPortfolioValueUsd: 0,
    reservedUsd: 0,
    totalAllocatedUsd: 0,
    totalCurrentValueUsd: 0,
    totalRealizedPnlUsd: 0,
    totalUnrealizedPnlUsd: 0,
    totalUnrealizedPnlPct: 0,
    healthNote: "Portfolio lifecycle will appear after the next completed scan.",
  };
  const executionState = snapshot?.executionState ?? {
    enabled: false,
    dryRun: true,
    mode: "paper",
    router: "fourmeme",
    configured: false,
    liveTradingArmed: false,
    readinessScore: 0,
    readinessTotal: 0,
    readinessChecks: [],
    nextAction: "Execution state will appear after the next completed scan.",
    risk: {
      maxBuyBnb: 0,
      maxDailyDeployBnb: 0,
      maxSlippageBps: 0,
      maxActivePositions: 0,
      minEntryMcapUsd: 0,
      maxEntryMcapUsd: 0,
      minLiquidityUsd: 0,
      minVolumeUsdM5: 0,
      minVolumeUsdH1: 0,
      minBuyersM5: 0,
      minNetBuysM5: 0,
      minPoolAgeMinutes: 0,
      maxPoolAgeMinutes: 0,
      maxPriceChangeH1Pct: 0,
      allowedQuoteOnly: true,
    },
    gooLane: undefined,
    plans: [],
    cycleSummary: {
      consideredCount: 0,
      eligibleCount: 0,
      attemptedCount: 0,
      dryRunCount: 0,
      executedCount: 0,
      skippedCount: 0,
      failedCount: 0,
      note: "Execution cycle has not run yet for this snapshot.",
    },
  };
  const tradeLedger = snapshot?.tradeLedger ?? {
    records: [],
    lastUpdatedAt: null,
    totalExecutedBnb: 0,
    totalDryRunBnb: 0,
  };
  const distributionPlan = snapshot?.distributionPlan ?? {
    enabled: false,
    holderTokenAddress: null,
    snapshotPath: ".elizaok/holder-snapshot.json",
    snapshotSource: "none",
    snapshotGeneratedAt: null,
    snapshotBlockNumber: null,
    minEligibleBalance: 0,
    eligibleHolderCount: 0,
    totalQualifiedBalance: 0,
    distributionPoolUsd: 0,
    maxRecipients: 0,
    note: "Distribution state will appear after configuration is enabled.",
    selectedAsset: {
      mode: "none",
      tokenAddress: null,
      tokenSymbol: null,
      totalAmount: null,
      walletBalance: null,
      walletQuoteUsd: null,
      sourcePositionTokenAddress: null,
      reason: "Distribution asset selection will appear after configuration is enabled.",
    },
    recipients: [],
    publication: null,
  };
  const distributionExecution = snapshot?.distributionExecution ?? {
    enabled: false,
    dryRun: true,
    configured: false,
    liveExecutionArmed: false,
    readinessScore: 0,
    readinessTotal: 0,
    readinessChecks: [],
    nextAction: "Distribution execution state will appear after the next completed scan.",
    assetTokenAddress: null,
    assetTotalAmount: null,
    walletAddress: null,
    manifestPath: null,
    manifestFingerprint: null,
    maxRecipientsPerRun: 0,
    cycleSummary: {
      attemptedCount: 0,
      dryRunCount: 0,
      executedCount: 0,
      skippedCount: 0,
      failedCount: 0,
      note: "Distribution execution is idle.",
    },
  };
  const distributionLedger = snapshot?.distributionLedger ?? {
    records: [],
    lastUpdatedAt: null,
    totalRecipientsExecuted: 0,
    totalRecipientsDryRun: 0,
  };
  const distributionExecutedRecipients = new Set(
    distributionLedger.records
      .filter(
        (record) =>
          record.disposition === "executed" &&
          distributionExecution.manifestFingerprint &&
          record.manifestFingerprint === distributionExecution.manifestFingerprint
      )
      .map((record) => record.recipientAddress.toLowerCase())
  );
  const distributionPendingRecipients = distributionPlan.recipients
    .filter((recipient) => !distributionExecutedRecipients.has(recipient.address.toLowerCase()))
    .slice(0, Math.max(1, distributionExecution.maxRecipientsPerRun || 5));
  const requestUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const pathname = requestUrl.pathname;

  if (pathname === "/assets/elizaok-logo.png") {
    for (const assetPath of ELIZAOK_LOGO_ASSET_PATHS) {
      try {
        const content = await readFile(assetPath);
        sendBinary(res, 200, "image/png", content);
        return;
      } catch {
        continue;
      }
    }

    sendJson(res, 404, { error: "Logo asset not found" });
    return;
  }

  if (pathname === "/assets/elizaok-banner.png") {
    for (const assetPath of ELIZAOK_BANNER_ASSET_PATHS) {
      try {
        const content = await readFile(assetPath);
        sendBinary(res, 200, "image/png", content);
        return;
      } catch {
        continue;
      }
    }

    sendJson(res, 404, { error: "Banner asset not found" });
    return;
  }

  if (pathname === "/health") {
    sendJson(res, 200, {
      status: "ok",
      agent: runtime.character.name,
      discoveryEnabled: config.enabled,
      gooEnabled: config.goo.enabled,
      executionEnabled: executionState.enabled,
      executionDryRun: executionState.dryRun,
      executionMode: executionState.mode,
      executionRouter: executionState.router,
      executionLiveTradingArmed: executionState.liveTradingArmed,
      latestRunId: snapshot?.summary.runId ?? null,
    });
    return;
  }

  if (pathname === "/api/elizaok/latest") {
    if (!snapshot) {
      sendJson(res, 404, { error: "No snapshot available yet" });
      return;
    }

    sendJson(res, 200, snapshot);
    return;
  }

  if (pathname === "/api/elizaok/execution") {
    sendJson(res, 200, executionState);
    return;
  }

  if (pathname === "/api/elizaok/trades") {
    sendJson(res, 200, tradeLedger);
    return;
  }

  if (pathname === "/api/elizaok/history") {
    if (!snapshot) {
      sendJson(res, 404, { error: "No snapshot available yet" });
      return;
    }

    sendJson(res, 200, {
      generatedAt: snapshot.generatedAt,
      history: recentHistory,
    });
    return;
  }

  if (pathname === "/api/elizaok/simulation") {
    if (!snapshot) {
      sendJson(res, 404, { error: "No snapshot available yet" });
      return;
    }

    sendJson(res, 200, {
      generatedAt: snapshot.generatedAt,
      simulation: treasurySimulation,
    });
    return;
  }

  if (pathname === "/api/elizaok/portfolio") {
    if (!snapshot) {
      sendJson(res, 404, { error: "No snapshot available yet" });
      return;
    }

    sendJson(res, 200, {
      generatedAt: snapshot.generatedAt,
      portfolio: portfolioLifecycle,
    });
    return;
  }

  if (pathname === "/api/elizaok/portfolio/positions") {
    const tokenAddress = requestUrl.searchParams.get("token")?.toLowerCase();
    if (!tokenAddress) {
      sendJson(res, 400, { error: "Missing token query parameter" });
      return;
    }
    if (!snapshot) {
      sendJson(res, 404, { error: "No snapshot available yet" });
      return;
    }

    const detail = buildPortfolioPositionDetail(snapshot, tokenAddress);
    if (!detail.position && detail.timeline.length === 0) {
      sendJson(res, 404, { error: "Portfolio position not found" });
      return;
    }

    sendJson(res, 200, {
      generatedAt: snapshot.generatedAt,
      detail,
    });
    return;
  }

  if (pathname === "/api/elizaok/timeline") {
    if (!snapshot) {
      sendJson(res, 404, { error: "No snapshot available yet" });
      return;
    }

    sendJson(res, 200, {
      generatedAt: snapshot.generatedAt,
      timeline: portfolioLifecycle.timeline,
    });
    return;
  }

  if (pathname === "/api/elizaok/distribution") {
    if (!snapshot) {
      sendJson(res, 404, { error: "No snapshot available yet" });
      return;
    }

    sendJson(res, 200, {
      generatedAt: snapshot.generatedAt,
      distribution: distributionPlan,
      execution: distributionExecution,
      ledger: distributionLedger,
    });
    return;
  }

  if (pathname === "/api/elizaok/distribution/run") {
    if (req.method !== "POST") {
      sendJson(res, 405, {
        error: "Method not allowed",
        detail: "Use POST to trigger a manual distribution run.",
      });
      return;
    }
    if (!snapshot) {
      sendJson(res, 404, { error: "No snapshot available yet" });
      return;
    }

    const refreshedDistributionPlan = await buildDistributionPlan(
      config.distribution,
      snapshot.treasurySimulation,
      config.execution.rpcUrl,
      snapshot.portfolioLifecycle
    );
    const { distributionExecution: refreshedExecution, distributionLedger: refreshedLedger } =
      await executeDistributionLane({
        config: config.distribution,
        distributionPlan: refreshedDistributionPlan,
        reportsDir: config.reportsDir,
        rpcUrl: config.execution.rpcUrl,
      });

    await persistDistributionExecutionState(
      snapshot,
      config.reportsDir,
      refreshedDistributionPlan,
      refreshedExecution,
      refreshedLedger
    );

    sendJson(res, 200, {
      generatedAt: new Date().toISOString(),
      message: "Manual distribution run completed.",
      distribution: refreshedDistributionPlan,
      execution: refreshedExecution,
      ledger: refreshedLedger,
    });
    return;
  }

  if (pathname === "/api/elizaok/distribution/execution") {
    if (!snapshot) {
      sendJson(res, 404, { error: "No snapshot available yet" });
      return;
    }

    sendJson(res, 200, {
      generatedAt: snapshot.generatedAt,
      execution: distributionExecution,
    });
    return;
  }

  if (pathname === "/api/elizaok/distribution/ledger") {
    if (!snapshot) {
      sendJson(res, 404, { error: "No snapshot available yet" });
      return;
    }

    sendJson(res, 200, {
      generatedAt: snapshot.generatedAt,
      ledger: distributionLedger,
    });
    return;
  }

  if (pathname === "/api/elizaok/distribution/pending") {
    if (!snapshot) {
      sendJson(res, 404, { error: "No snapshot available yet" });
      return;
    }

    sendJson(res, 200, {
      generatedAt: snapshot.generatedAt,
      manifestFingerprint: distributionExecution.manifestFingerprint,
      pendingRecipients: distributionPendingRecipients,
      pendingCount: Math.max(0, distributionPlan.recipients.length - distributionExecutedRecipients.size),
      maxRecipientsPerRun: distributionExecution.maxRecipientsPerRun,
    });
    return;
  }

  if (pathname === "/api/elizaok/goo") {
    const readiness = buildGooReadiness(config);
    sendJson(res, 200, {
      generatedAt: snapshot?.generatedAt ?? null,
      enabled: config.goo.enabled,
      configured: readiness.configured,
      readinessChecks: {
        enabled: config.goo.enabled,
        rpcUrlConfigured: Boolean(config.goo.rpcUrl),
        registryConfigured: Boolean(config.goo.registryAddress),
      },
      readinessScore: readiness.score,
      readinessTotal: readiness.total,
      readinessChecklist: readiness.checklist,
      nextAction: readiness.nextAction,
      registryAddress: config.goo.registryAddress,
      rpcUrlConfigured: Boolean(config.goo.rpcUrl),
      lookbackBlocks: config.goo.lookbackBlocks,
      maxAgents: config.goo.maxAgents,
      candidates: snapshot?.topGooCandidates ?? [],
    });
    return;
  }

  if (pathname === "/api/elizaok/goo/candidates") {
    const candidates = snapshot?.topGooCandidates ?? [];
    const agentId = requestUrl.searchParams.get("agent");
    if (agentId) {
      const detail = candidates.find((candidate) => candidate.agentId === agentId);
      if (!detail) {
        sendJson(res, 404, { error: "Goo candidate not found" });
        return;
      }

      sendJson(res, 200, buildGooCandidateDetail(detail, config));
      return;
    }

    sendJson(res, 200, {
      generatedAt: snapshot?.generatedAt ?? null,
      candidates: candidates.map((candidate) => buildGooCandidateDetail(candidate, config)),
    });
    return;
  }

  if (pathname === "/api/elizaok/watchlist") {
    if (!snapshot) {
      sendJson(res, 404, { error: "No snapshot available yet" });
      return;
    }

    sendJson(res, 200, {
      generatedAt: snapshot.generatedAt,
      watchlist: snapshot.watchlist,
    });
    return;
  }

  if (pathname === "/api/elizaok/candidates") {
    const candidateHistory = await loadCandidateHistoryFromDisk(config.reportsDir);
    const tokenAddress = requestUrl.searchParams.get("token")?.toLowerCase();

    if (tokenAddress) {
      const detail = candidateHistory.find((candidate) => candidate.tokenAddress.toLowerCase() === tokenAddress);
      if (!detail) {
        sendJson(res, 404, { error: "Candidate not found" });
        return;
      }

      sendJson(res, 200, {
        ...detail,
        portfolio: buildPortfolioPositionDetail(snapshot, tokenAddress),
      });
      return;
    }

    sendJson(res, 200, {
      generatedAt: snapshot?.generatedAt ?? null,
      candidates: candidateHistory.slice(0, 50).map((detail) => detail.latest),
    });
    return;
  }

  if (pathname === "/candidate") {
    const candidateHistory = await loadCandidateHistoryFromDisk(config.reportsDir);
    const tokenAddress = requestUrl.searchParams.get("token")?.toLowerCase();
    if (!tokenAddress) {
      sendJson(res, 400, { error: "Missing token query parameter" });
      return;
    }

    const detail = candidateHistory.find((candidate) => candidate.tokenAddress.toLowerCase() === tokenAddress);
    if (!detail) {
      sendJson(res, 404, { error: "Candidate not found" });
      return;
    }

    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(renderCandidateDetail(detail, buildPortfolioPositionDetail(snapshot, tokenAddress)));
    return;
  }

  if (pathname === "/goo-candidate") {
    const agentId = requestUrl.searchParams.get("agent");
    const candidate = snapshot?.topGooCandidates.find((item) => item.agentId === agentId);
    if (!candidate) {
      sendJson(res, 404, { error: "Goo candidate not found" });
      return;
    }

    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(renderGooCandidateDetail(buildGooCandidateDetail(candidate, config)));
    return;
  }

  if (pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(renderHtml(snapshot));
    return;
  }

  sendJson(res, 404, { error: "Not found" });
}

export function startDashboardServer(runtime: AgentRuntime) {
  const config = getDiscoveryConfig();
  if (!config.dashboard.enabled) {
    runtime.logger.info("ElizaOK dashboard server disabled");
    return null;
  }

  const server = createServer((req, res) => {
    void handleRequest(req, res, runtime).catch((error) => {
      runtime.logger.error({ error }, "ElizaOK dashboard server request failed");
      sendJson(res, 500, { error: "Internal server error" });
    });
  });

  server.listen(config.dashboard.port, () => {
    runtime.logger.info(
      { port: config.dashboard.port },
      "ElizaOK dashboard server started"
    );
  });

  return server;
}
