// resolveCompanionInferenceNotice drives the TUI "notice" line and the
// data-view-state `inferenceNoticeKind`. Each branch is exercised here with a
// stub `t()` that echoes the key, so the asserted tooltip pins the exact branch
// taken (and the credits-error branch returns the trimmed raw message, not a
// translation key).

import { describe, expect, it, vi } from "vitest";

// resolve-companion-inference-notice imports modelLooksLikeElizaCloudHosted from
// `@elizaos/ui/utils`. The vitest alias maps that subpath to the giant
// packages/ui/src/index.ts barrel, which transitively pulls in react-router-dom
// and fails to resolve under the plugin's test context. Mock the bare module
// (the alias collapses `@elizaos/ui` and `@elizaos/ui/utils` to the same id) and
// provide the REAL heuristic (verified against
// packages/shared/src/utils/eliza-cloud-model-route.ts) so the disconnected
// cloud-hosted branch is exercised honestly.
vi.mock("@elizaos/ui", () => ({
  modelLooksLikeElizaCloudHosted: (model: string | undefined): boolean => {
    if (!model || typeof model !== "string") return false;
    const m = model.toLowerCase();
    return (
      m.includes("kimi") ||
      m.includes("moonshot") ||
      (m.includes("eliza") && m.includes("cloud"))
    );
  },
}));

import {
  type CompanionInferenceNotice,
  resolveCompanionInferenceNotice,
} from "./resolve-companion-inference-notice";

const echo = (key: string) => key;

type Args = Parameters<typeof resolveCompanionInferenceNotice>[0];

function resolve(overrides: Partial<Args>): CompanionInferenceNotice | null {
  return resolveCompanionInferenceNotice({
    elizaCloudConnected: false,
    elizaCloudAuthRejected: false,
    elizaCloudCreditsError: null,
    elizaCloudEnabled: false,
    chatLastUsageModel: undefined,
    hasInterruptedAssistant: false,
    t: echo,
    ...overrides,
  });
}

describe("resolveCompanionInferenceNotice", () => {
  it("returns a cloud/danger notice when connected and auth is rejected", () => {
    expect(
      resolve({ elizaCloudConnected: true, elizaCloudAuthRejected: true }),
    ).toEqual({
      kind: "cloud",
      variant: "danger",
      tooltip: "notice.elizaCloudAuthRejected",
    });
  });

  it("returns a cloud/warn notice with the trimmed credits-error message", () => {
    expect(
      resolve({
        elizaCloudConnected: true,
        elizaCloudCreditsError: "  out of credits  ",
      }),
    ).toEqual({
      kind: "cloud",
      variant: "warn",
      tooltip: "out of credits",
    });
  });

  it("prefers the auth-rejected danger over a credits error when both set", () => {
    const notice = resolve({
      elizaCloudConnected: true,
      elizaCloudAuthRejected: true,
      elizaCloudCreditsError: "out of credits",
    });
    expect(notice?.variant).toBe("danger");
    expect(notice?.tooltip).toBe("notice.elizaCloudAuthRejected");
  });

  it("returns a cloud/warn notice when disconnected but cloud is enabled", () => {
    expect(
      resolve({ elizaCloudConnected: false, elizaCloudEnabled: true }),
    ).toEqual({
      kind: "cloud",
      variant: "warn",
      tooltip: "chat.inferenceCloudNotConnected",
    });
  });

  it("returns a cloud/warn notice when disconnected and the last model looks cloud-hosted", () => {
    // modelLooksLikeElizaCloudHosted matches kimi/moonshot/eliza-cloud routes.
    expect(
      resolve({
        elizaCloudConnected: false,
        elizaCloudEnabled: false,
        chatLastUsageModel: "kimi-k2",
      }),
    ).toEqual({
      kind: "cloud",
      variant: "warn",
      tooltip: "chat.inferenceCloudNotConnected",
    });
  });

  it("returns a settings/warn notice for interrupted assistant turns only", () => {
    expect(
      resolve({
        // connected with no cloud errors so the cloud branches are skipped.
        elizaCloudConnected: true,
        hasInterruptedAssistant: true,
      }),
    ).toEqual({
      kind: "settings",
      variant: "warn",
      tooltip: "chat.inferenceStreamInterrupted",
    });
  });

  it("returns null when everything is healthy", () => {
    expect(
      resolve({
        elizaCloudConnected: true,
        elizaCloudEnabled: true,
        chatLastUsageModel: "gpt-test",
      }),
    ).toBeNull();
  });

  it("returns null when disconnected, cloud disabled, and the model is not cloud-hosted", () => {
    expect(
      resolve({
        elizaCloudConnected: false,
        elizaCloudEnabled: false,
        chatLastUsageModel: "gpt-test",
      }),
    ).toBeNull();
  });
});
