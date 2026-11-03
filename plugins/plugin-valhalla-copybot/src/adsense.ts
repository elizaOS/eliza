/** ads.txt line for the developer site. Empty until AdSense is explicitly on. */
export function adsTxt(env: Record<string, string | undefined> = process.env): string {
  if (env.ADSENSE_ENABLED !== "true") return "";
  const client = env.ADSENSE_CLIENT_ID?.trim() ?? "";
  const pub = client.startsWith("ca-") ? client.slice(3) : "";
  if (!/^pub-\d{16}$/.test(pub)) return "";
  return `google.com, ${pub}, DIRECT, f08c47fec0942fa0\n`;
}

/** Web AdSense markup. Off unless the owner turns the flag on and sets a client id. */
export function adsenseSnippet(env: Record<string, string | undefined> = process.env): string {
  if (env.ADSENSE_ENABLED !== "true") return "";
  const client = env.ADSENSE_CLIENT_ID?.trim() ?? "";
  if (!/^ca-pub-\d{16}$/.test(client)) return "";
  const slot = env.ADSENSE_SLOT?.trim() ?? "";
  const slotAttr = /^\d{8,12}$/.test(slot) ? ` data-ad-slot="${slot}"` : "";
  return (
    `<aside class="valhalla-adsense" style="position:fixed;left:0;right:0;bottom:0;z-index:20;height:60px;background:#050507;border-top:1px solid #1c1a16;overflow:hidden">` +
    `<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${client}" crossorigin="anonymous"></script>` +
    `<ins class="adsbygoogle" style="display:block" data-ad-client="${client}" data-ad-format="auto" data-full-width-responsive="true"${slotAttr}></ins>` +
    `<script>(adsbygoogle=window.adsbygoogle||[]).push({})</script></aside>`
  );
}
