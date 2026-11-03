export const DESK_VERSION = "0.1.1";

export const WHATS_NEW = [
  "Self-repair watches hung calls and restarts only when nothing is open.",
  "Valhalla Brain can explain a skip. It cannot place a trade.",
  "The phone can open a demo before any wallet exists.",
];

export function newerRelease(current: string, tag: string): boolean {
  const parse = (value: string) =>
    value
      .replace(/^v/i, "")
      .split(/[.-]/)
      .slice(0, 3)
      .map((part) => Number.parseInt(part, 10) || 0);
  const left = parse(current);
  const right = parse(tag);
  for (let index = 0; index < 3; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    if (b > a) return true;
    if (b < a) return false;
  }
  return false;
}

export async function checkDesktopUpdate(
  current: string,
  fetchImpl: typeof fetch = fetch
): Promise<{ update: boolean; latest: string; notes: string }> {
  const response = await fetchImpl(
    "https://api.github.com/repos/TokenJunction/eliza-valhalla/releases/latest",
    { headers: { accept: "application/vnd.github+json" } }
  );
  if (!response.ok) return { update: false, latest: current, notes: WHATS_NEW.join(" ") };
  const body = (await response.json()) as { tag_name?: string; body?: string };
  const latest = body.tag_name ?? current;
  return {
    update: newerRelease(current, latest),
    latest,
    notes: body.body?.slice(0, 400) || WHATS_NEW.join(" "),
  };
}
