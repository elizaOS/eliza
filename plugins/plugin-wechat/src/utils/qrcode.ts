/**
 * Display a QR code URL to the terminal.
 * Prints the URL for the user to open in a browser.
 * A vendored text-based QR renderer could be added here later.
 */
export function displayQRUrl(url: string): void {
  console.log("");
  console.log("╔══════════════════════════════════════════╗");
  console.log("║  Scan this QR code with WeChat to login  ║");
  console.log("╠══════════════════════════════════════════╣");
  console.log(`║  ${url}`);
  console.log("╚══════════════════════════════════════════╝");
  console.log("");
  console.log("Open the URL above in your browser to see the QR code.");
  console.log("");
}
