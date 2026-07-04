/**
 * Last-resort boot error surface.
 *
 * `main()` awaits several fallible pre-mount steps (e.g. the dynamic
 * `@elizaos/ui/voice` chunks). If any rejects, React never mounts and the user
 * is stranded on a permanent blank page with no recovery — most commonly a
 * stale `index.html` pointing at purged hashed chunks right after a prod
 * redeploy, or a flaky network. The app's root ErrorBoundary can't help
 * because React was never mounted.
 *
 * Paint a minimal, dependency-free reload card instead. A full reload
 * re-fetches `index.html` and discards the in-session rejected-promise caches
 * (`cachedDynamicImport` / `appModulesInitialized`), so it is the correct
 * recovery path.
 */
export function renderBootFailure(
  error: unknown,
  doc: Document = document,
): void {
  try {
    console.error("[boot] app failed to start", error);
  } catch {
    // never let logging mask the recovery UI
  }

  const root = doc.getElementById("root");
  if (!root) return;
  root.textContent = "";

  const card = doc.createElement("div");
  card.setAttribute("data-testid", "boot-failure");
  card.style.cssText =
    "display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;gap:16px;padding:24px;text-align:center;font-family:system-ui,-apple-system,sans-serif;color:#e5e7eb;background:#0f1117";

  const message = doc.createElement("p");
  message.textContent =
    "Couldn't start the app. This can happen right after an update.";
  message.style.cssText =
    "margin:0;font-size:14px;max-width:24rem;line-height:1.5";

  const button = doc.createElement("button");
  button.type = "button";
  button.textContent = "Reload";
  button.style.cssText =
    "padding:8px 20px;border-radius:6px;border:1px solid #3f3f46;background:#18181b;color:#fafafa;font-size:14px;cursor:pointer";
  button.addEventListener("click", () => {
    doc.defaultView?.location.reload();
  });

  card.appendChild(message);
  card.appendChild(button);
  root.appendChild(card);
}
