/**
 * Prints the QR-code login URL to the terminal (boxed) for the user to open in
 * a browser and scan with the WeChat mobile app.
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
