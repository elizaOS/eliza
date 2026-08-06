import type { VerifyArtifact } from "../types/index";
import type { VerifyProjectProfile } from "./recipes";

export const VERIFY_ARTIFACT_DIR = ".grok/verify-artifacts";
export const VERIFY_SCREENSHOT_PATH = `${VERIFY_ARTIFACT_DIR}/verify-screenshot.png`;
export const VERIFY_VIDEO_PATH = `${VERIFY_ARTIFACT_DIR}/verify-smoke.webm`;
export const VERIFY_LOG_PATH = `${VERIFY_ARTIFACT_DIR}/app.log`;

export function getVerifyArtifacts(): VerifyArtifact[] {
  return [
    { kind: "log", path: VERIFY_LOG_PATH, description: "Captured app stdout/stderr from the verify run" },
    {
      kind: "screenshot",
      path: VERIFY_SCREENSHOT_PATH,
      description: "Final browser screenshot from smoke verification",
    },
    { kind: "video", path: VERIFY_VIDEO_PATH, description: "Recorded browser smoke flow" },
  ];
}

export function buildReadinessGuidance(profile: VerifyProjectProfile): string[] {
  if (profile.recipe.smokeKind !== "http" || !profile.recipe.startCommand || !profile.recipe.startPort) {
    return [
      "- If you start any process, capture stdout/stderr into a log file under .grok/verify-artifacts whenever practical.",
    ];
  }

  const target = profile.recipe.smokeTarget ?? `http://127.0.0.1:${profile.recipe.startPort}`;
  return [
    `- Start the app with logs redirected to ${VERIFY_LOG_PATH} so failures leave evidence.`,
    `- Before running browser checks, wait for readiness at ${target}. Prefer a bounded curl loop or equivalent readiness check instead of guessing.`,
    "- If readiness never succeeds, include the final log tail and exact readiness command output in the report.",
  ];
}

export function buildBrowserGuidance(profile: VerifyProjectProfile): string[] {
  if (profile.recipe.smokeKind === "http" && profile.recipe.smokeTarget) {
    return [
      `- REQUIRED: After the dev server is running, you MUST run browser smoke tests against ${profile.recipe.smokeTarget}.`,
      "- The agent-browser command runs on the HOST, not inside the sandbox. It WILL work. Do not skip it or assume it is unavailable.",
      "- CRITICAL SEQUENCING: The dev server MUST stay running for the entire browser test. Do NOT stop the server until after recording is stopped and the browser is closed.",
      "",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: shell variable reference in prompt text
      "- IMPORTANT: All artifact paths MUST be absolute. Use `$(pwd)/${VERIFY_ARTIFACT_DIR}` to construct them. Example: `$(pwd)/.grok/verify-artifacts/verify-smoke.webm`.",
      "",
      "- Browser smoke test procedure (run each step as a SEPARATE bash tool call):",
      `  1. mkdir -p ${VERIFY_ARTIFACT_DIR}`,
      `  2. agent-browser record start "$(pwd)/${VERIFY_VIDEO_PATH}"`,
      "  3. sleep 1",
      `  4. agent-browser --screenshot-dir "$(pwd)/${VERIFY_ARTIFACT_DIR}" open ${profile.recipe.smokeTarget}`,
      "  5. agent-browser wait --load networkidle",
      "  6. sleep 2",
      `  7. agent-browser --screenshot-dir "$(pwd)/${VERIFY_ARTIFACT_DIR}" screenshot`,
      "  8. agent-browser get title",
      "",
      "- INTERACTIVE TESTING (do this now, while recording is still running):",
      "  Act like a real user doing an integration test. The goal is to verify the app actually works, not just that it loads.",
      "  - Run each agent-browser command as a SEPARATE bash tool call. Do NOT chain them.",
      "  - After each interaction, run `sleep 2` so the recording captures the result.",
      "  - Use `agent-browser snapshot` to see the page structure and interactive elements.",
      "  - Click links, buttons, and navigation using `agent-browser click <ref>` (refs from snapshot).",
      "  - After each click, `agent-browser wait --load networkidle && sleep 2`, then snapshot and screenshot.",
      "  - Check for console errors using `agent-browser console`.",
      "  - Test at least: home page loads with content, primary navigation works, no JS errors in console.",
      "  - If the app has forms, try filling one. If it has a login page, verify it renders.",
      "  - Spend 3-5 interactions exploring the critical path. Do not rush.",
      "",
      "- Teardown (after interactive testing, run each as a separate bash call):",
      "  9. agent-browser record stop",
      "  10. sleep 2",
      `  11. ls -la "$(pwd)/${VERIFY_VIDEO_PATH}" (verify the video file exists and has a non-zero size)`,
      "  12. agent-browser close",
      "  13. Only NOW stop the dev server (kill the background process).",
      "",
      `- Keep all screenshots and video under ${VERIFY_ARTIFACT_DIR}. Include their exact paths in the Evidence section.`,
      "- If the video file does not exist after `record stop`, note that in Blockers.",
      "- If any browser command fails, report the exact error output. Do not skip browser checks.",
    ];
  }

  if ((profile.sandboxSettings.ports?.length ?? 0) > 1) {
    return [
      "- Multiple forwarded ports are configured, so browser smoke testing is ambiguous.",
      "- Skip browser checks unless the user clearly identifies which forwarded localhost URL to verify.",
    ];
  }

  if (profile.recipe.smokeKind === "cli") {
    return ["- This project appears to need CLI-style runtime validation rather than browser smoke testing."];
  }

  return [
    "- No unambiguous forwarded localhost URL is configured, so browser smoke testing is optional and should usually be skipped.",
    "- If the app can still be verified with bash-only checks, do that and explain why browser checks were skipped.",
  ];
}

export function buildEvidenceGuidance(): string[] {
  const artifacts = getVerifyArtifacts();
  return [
    "- Always include exact artifact file paths in the Evidence section when they exist.",
    ...artifacts.map((artifact) => `- Artifact target: ${artifact.path} (${artifact.description}).`),
  ];
}
