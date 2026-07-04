/**
 * XR connect route serves the headset pairing page with the app URL encoded for
 * local network or tunnel access.
 */
import { networkInterfaces } from "node:os";
import type { Route } from "@elizaos/core";

function getLocalIp(): string {
	const nets = networkInterfaces();
	for (const iface of Object.values(nets)) {
		for (const net of iface ?? []) {
			if (!net.internal && net.family === "IPv4") return net.address;
		}
	}
	return "127.0.0.1";
}

function getAppUrl(): string {
	// Connect scripts set this when a tunnel is active.
	if (process.env.XR_APP_URL) return process.env.XR_APP_URL;
	const port = process.env.VITE_PORT ?? "5173";
	return `http://${getLocalIp()}:${port}`;
}

function htmlPage(appUrl: string): string {
	const encoded = encodeURIComponent(appUrl);
	return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Connect XR Headset</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0 }
    body { font-family: system-ui, sans-serif; background: #0f0f0f; color: #e5e5e5;
           min-height: 100vh; display: flex; align-items: center; justify-content: center; }
    .card { background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 16px;
            padding: 40px; max-width: 480px; width: 100%; text-align: center; }
    h1 { font-size: 1.5rem; margin-bottom: 8px; }
    .sub { color: #888; font-size: 0.9rem; margin-bottom: 28px; }
    #qrcanvas { border-radius: 12px; background: white; padding: 12px;
                display: block; margin: 0 auto 24px; }
    .url { background: #111; border: 1px solid #333; border-radius: 8px;
           padding: 10px 16px; font-family: monospace; font-size: 0.85rem;
           word-break: break-all; margin-bottom: 24px; }
    .steps { text-align: left; font-size: 0.85rem; color: #aaa; line-height: 1.7; }
    .steps li { margin-bottom: 4px; }
    .warn { margin-top: 20px; font-size: 0.78rem; color: #f59e0b; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Connect XR Headset</h1>
    <p class="sub">Scan to open the XR app on your device</p>
    <canvas id="qrcanvas"></canvas>
    <div class="url">${appUrl}</div>
    <ol class="steps">
      <li>Put on your headset and open the browser</li>
      <li>Scan the QR code or type the URL above</li>
      <li>Allow microphone and camera access when prompted</li>
      <li>The agent will connect automatically</li>
    </ol>
    ${appUrl.startsWith("http://") ? `<p class="warn">⚠ HTTP URL — WebXR requires HTTPS on device.<br>Run <code>bun run connect</code> for an HTTPS tunnel.</p>` : ""}
  </div>
  <script src="https://cdn.jsdelivr.net/npm/qrcode@1.5.4/build/qrcode.min.js"></script>
  <script>
    var url = decodeURIComponent("${encoded}");
    if (typeof QRCode !== "undefined") {
      QRCode.toCanvas(document.getElementById("qrcanvas"), url, { width: 220, margin: 2 }, function(err) {
        if (err) document.getElementById("qrcanvas").style.display = "none";
      });
    } else {
      document.getElementById("qrcanvas").style.display = "none";
    }
  </script>
</body>
</html>`;
}

export const connectRoute: Route = {
	type: "GET",
	path: "/xr/connect",
	description:
		"Returns an HTML page with a QR code to connect an XR headset. Set XR_APP_URL env var (or run `bun run connect` in plugins/plugin-facewear/app-xr) to show the correct public URL.",
	routeHandler: async (_ctx) => {
		const url = getAppUrl();
		return {
			status: 200,
			headers: { "Content-Type": "text/html; charset=utf-8" },
			body: htmlPage(url),
		};
	},
};
