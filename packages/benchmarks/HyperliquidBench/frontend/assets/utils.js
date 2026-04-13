export async function fetchJSON(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to fetch ${url}: ${resp.status}`);
  return resp.json();
}

export function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = () => reject(fr.error);
    fr.onload = () => resolve(String(fr.result || ""));
    fr.readAsText(file);
  });
}

export function parseJSONL(text) {
  return text.split(/\r?\n/).filter(Boolean).map((line, i) => {
    try { return JSON.parse(line); }
    catch (e) { console.warn("Bad JSONL line", i+1, e); return null; }
  }).filter(Boolean);
}

export function fmtScore(n) {
  const x = Number(n || 0);
  return (Math.round(x * 100) / 100).toFixed(2);
}

export function domainPill(name) {
  const key = String(name || "-").toLowerCase();
  const cls = key === "perp" ? "tag-perp"
    : key === "account" ? "tag-account"
    : key === "risk" ? "tag-risk"
    : "tag-generic";
  return `<span class="tag ${cls}">${name}</span>`;
}

export function signatureDomain(signature) {
  if (!signature) return null;
  return String(signature).split('.')[0] || null;
}

const HIAN_TAGS = {
  PASS: 'tag-pass',
  PASS_WITH_WARNINGS: 'tag-warning',
  PARTIAL: 'tag-partial',
  FAIL: 'tag-fail'
};

export function hianBadge(result) {
  if (!result) return '-';
  const key = String(result).toUpperCase();
  const cls = HIAN_TAGS[key] || 'tag-warning';
  const label = key.replace(/_/g, ' ');
  return `<span class="tag ${cls}">${label}</span>`;
}
