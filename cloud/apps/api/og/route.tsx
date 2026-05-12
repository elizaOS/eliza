import { Hono } from "hono";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function clampText(value: string | null, fallback: string, maxLength: number): string {
  const trimmed = value?.trim();
  if (!trimmed) return fallback;
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength - 1)}...` : trimmed;
}

app.get("/", (c) => {
  const title = escapeXml(clampText(c.req.query("title") ?? null, "Eliza Cloud", 90));
  const description = escapeXml(
    clampText(
      c.req.query("description") ?? c.req.query("subtitle") ?? null,
      "Build, run, and monetize Eliza agents.",
      150,
    ),
  );
  const label = escapeXml(clampText(c.req.query("label") ?? null, "elizaOS", 36));

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-label="${title}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#101828"/>
      <stop offset="0.54" stop-color="#16383f"/>
      <stop offset="1" stop-color="#f59e0b"/>
    </linearGradient>
    <linearGradient id="line" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#22d3ee"/>
      <stop offset="1" stop-color="#facc15"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/>
  <rect x="64" y="64" width="1072" height="502" rx="28" fill="rgba(15,23,42,0.58)" stroke="rgba(255,255,255,0.24)" stroke-width="2"/>
  <path d="M96 470 C260 372 365 520 526 422 C690 322 827 440 1050 286" fill="none" stroke="url(#line)" stroke-width="8" stroke-linecap="round" opacity="0.82"/>
  <circle cx="990" cy="174" r="68" fill="rgba(255,255,255,0.12)" stroke="rgba(255,255,255,0.32)" stroke-width="2"/>
  <text x="112" y="150" fill="#ffffff" font-family="Inter, Arial, sans-serif" font-size="30" font-weight="700" letter-spacing="0">${label}</text>
  <text x="112" y="302" fill="#ffffff" font-family="Inter, Arial, sans-serif" font-size="72" font-weight="800" letter-spacing="0">${title}</text>
  <text x="116" y="374" fill="#e5e7eb" font-family="Inter, Arial, sans-serif" font-size="32" font-weight="500" letter-spacing="0">${description}</text>
  <text x="112" y="514" fill="#cbd5e1" font-family="Inter, Arial, sans-serif" font-size="24" font-weight="600" letter-spacing="0">elizacloud.ai</text>
</svg>`;

  return new Response(svg, {
    status: 200,
    headers: {
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
});

export default app;
