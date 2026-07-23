// @vitest-environment jsdom

/**
 * Project Publish panel tests its Cloud gate, first-publish wizard, live
 * management state, and explicit stale-binding recovery with boundary doubles.
 */

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectSummary } from "../../../api/client-types-cloud";
import type { App } from "../lib/apps";
import type { ProjectPublicationSnapshot } from "../lib/project-publication";

const refreshMock = vi.hoisted(() => vi.fn());
const loginMock = vi.hoisted(() => vi.fn(async () => undefined));
const noticeMock = vi.hoisted(() => vi.fn());
const publishMock = vi.hoisted(() =>
  vi.fn((..._args: unknown[]): Promise<unknown> => Promise.resolve(undefined)),
);
const unpublishMock = vi.hoisted(() =>
  vi.fn(async (..._args: unknown[]) => undefined),
);
const deleteMock = vi.hoisted(() =>
  vi.fn((..._args: unknown[]): Promise<unknown> => Promise.resolve(undefined)),
);
const unbindMock = vi.hoisted(() =>
  vi.fn((..._args: unknown[]): Promise<unknown> => Promise.resolve(undefined)),
);
const notifyMock = vi.hoisted(() => vi.fn((..._args: unknown[]) => undefined));
const filesToBundleMock = vi.hoisted(() =>
  vi.fn((..._args: unknown[]): Promise<unknown> => Promise.resolve(undefined)),
);
const capabilityMock = vi.hoisted(() =>
  vi.fn((..._args: unknown[]): Promise<unknown> => Promise.resolve(undefined)),
);
const updateAppMock = vi.hoisted(() =>
  vi.fn(async (..._args: unknown[]) => undefined),
);
const apiMock = vi.hoisted(() =>
  vi.fn((..._args: unknown[]): Promise<unknown> => Promise.resolve(undefined)),
);
const openExternalMock = vi.hoisted(() =>
  vi.fn((..._args: unknown[]): boolean => false),
);
const storeKeyMock = vi.hoisted(() =>
  vi.fn((..._args: unknown[]) => undefined),
);

let connected = true;
let publication: ProjectPublicationSnapshot = { status: "unbound" };

const translate = (
  key: string,
  options?: Record<string, unknown> & { defaultValue?: string },
) => {
  let text = options?.defaultValue ?? key;
  for (const [name, value] of Object.entries(options ?? {})) {
    if (name !== "defaultValue") {
      text = text.replaceAll(`{{${name}}}`, String(value));
    }
  }
  return text;
};

vi.mock("../../../state", () => ({
  useAppSelectorShallow: (
    selector: (state: Record<string, unknown>) => unknown,
  ) =>
    selector({
      elizaCloudConnected: connected,
      elizaCloudLoginBusy: false,
      handleCloudLogin: loginMock,
      setActionNotice: noticeMock,
      t: translate,
    }),
}));
vi.mock("../../settings/CloudSettingsSectionShell", () => ({
  CloudSettingsSectionShell: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));
vi.mock("../../shell/CloudI18nProvider", () => ({
  useCloudT: () => translate,
}));
vi.mock("../../lib/api-client", () => ({
  api: (...args: unknown[]) => apiMock(...args),
}));
vi.mock("../lib/project-publication", () => ({
  useProjectPublication: () => ({ ...publication, refresh: refreshMock }),
  notifyProjectPublicationChanged: (...args: unknown[]) => notifyMock(...args),
}));
vi.mock("../lib/project-publish-workflow", () => ({
  publishProject: (...args: unknown[]) => publishMock(...args),
  unpublishProject: (...args: unknown[]) => unpublishMock(...args),
  deletePublishedProject: (...args: unknown[]) => deleteMock(...args),
  unbindLocalProjectCloudApp: (...args: unknown[]) => unbindMock(...args),
}));
vi.mock("../lib/frontend-hosting", () => ({
  filesToBundle: (...args: unknown[]) => filesToBundleMock(...args),
}));
vi.mock("../lib/apps", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/apps")>("../lib/apps");
  return {
    ...actual,
    getAppDeployCapability: (...args: unknown[]) => capabilityMock(...args),
    updateApp: (...args: unknown[]) => updateAppMock(...args),
  };
});
vi.mock("../lib/one-time-app-api-key", () => ({
  storeOneTimeAppApiKey: (...args: unknown[]) => storeKeyMock(...args),
}));
vi.mock("../lib/native-cloud-nav", () => ({
  openExternalUrlOnNative: (...args: unknown[]) => openExternalMock(...args),
  resolveCloudConsoleUrl: (path: string) => `https://cloud.example.test${path}`,
}));
vi.mock("./app-details-tabs", () => ({
  AppDetailsTabs: ({
    settingsProps,
  }: {
    settingsProps?: {
      onUnpublish?: () => Promise<void>;
      onDelete?: () => Promise<void>;
    };
  }) => (
    <div data-testid="cloud-management-tabs">
      <button type="button" onClick={() => void settingsProps?.onUnpublish?.()}>
        test unpublish
      </button>
      <button type="button" onClick={() => void settingsProps?.onDelete?.()}>
        test delete
      </button>
    </div>
  ),
}));

import { ProjectPublishPanel } from "./project-publish-panel";

const PROJECT: ProjectSummary = {
  id: "project-1",
  name: "Habit Tracker",
  localPath: "/work/habit-tracker",
  lastOpenedAt: "2026-07-23T00:00:00.000Z",
};

function makeApp(overrides: Partial<App> = {}): App {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Habit Tracker",
    description: "Build habits",
    slug: "habit-tracker",
    organization_id: "org-1",
    created_by_user_id: "user-1",
    app_url: "https://habit-tracker.sites.elizacloud.ai",
    allowed_origins: ["https://habit-tracker.sites.elizacloud.ai"],
    api_key_id: null,
    affiliate_code: null,
    referral_bonus_credits: "0.00",
    total_requests: 0,
    total_users: 0,
    total_credits_used: "0.00",
    logo_url: null,
    website_url: null,
    contact_email: null,
    metadata: {},
    deployment_status: "draft",
    production_url: null,
    last_deployed_at: null,
    github_repo: null,
    linked_character_ids: [],
    monetization_enabled: false,
    inference_markup_percentage: 0,
    purchase_share_percentage: 0,
    platform_offset_amount: 0,
    custom_pricing_enabled: false,
    total_creator_earnings: "0.00",
    total_platform_revenue: "0.00",
    discord_automation: null,
    telegram_automation: null,
    twitter_automation: null,
    promotional_assets: null,
    user_database_status: "none",
    user_database_uri: null,
    user_database_region: null,
    user_database_error: null,
    email_notifications: true,
    response_notifications: true,
    is_active: true,
    is_approved: true,
    review_status: "draft",
    review_content_hash: null,
    reviewed_at: null,
    created_at: "2026-07-23T00:00:00.000Z",
    updated_at: "2026-07-23T00:00:00.000Z",
    last_used_at: null,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  connected = true;
  publication = { status: "unbound" };
  for (const mock of [
    refreshMock,
    loginMock,
    noticeMock,
    publishMock,
    unpublishMock,
    deleteMock,
    unbindMock,
    notifyMock,
    filesToBundleMock,
    capabilityMock,
    updateAppMock,
    apiMock,
    openExternalMock,
    storeKeyMock,
  ]) {
    mock.mockReset();
  }
  loginMock.mockResolvedValue(undefined);
  unpublishMock.mockResolvedValue(undefined);
  updateAppMock.mockResolvedValue(undefined);
  openExternalMock.mockReturnValue(false);
});

describe("ProjectPublishPanel", () => {
  it("shows a designed Cloud connection gate without mounting a broken form", async () => {
    connected = false;
    render(<ProjectPublishPanel project={PROJECT} />);

    expect(screen.getByText("Connect Eliza Cloud to publish")).toBeTruthy();
    expect(screen.queryByTestId("project-publish-wizard")).toBeNull();

    await userEvent.click(
      screen.getByRole("button", { name: "Connect Eliza Cloud" }),
    );
    expect(loginMock).toHaveBeenCalledOnce();
  });

  it("publishes through the two-step managed-frontend wizard while container hosting is gated", async () => {
    capabilityMock.mockResolvedValue({
      enabled: false,
      reason: "organization_not_allowlisted",
    });
    filesToBundleMock.mockResolvedValue([
      { path: "index.html", content: "PGgxPkxpdmU8L2gxPg==" },
    ]);
    const bound = {
      ...PROJECT,
      cloudAppId: "11111111-1111-4111-8111-111111111111",
    };
    publishMock.mockResolvedValue({
      project: bound,
      app: makeApp(),
      publicUrl: "https://habit-tracker.sites.elizacloud.ai",
      apiKey: "eliza_once",
    });
    const changed = vi.fn();
    render(
      <ProjectPublishPanel project={PROJECT} onProjectChanged={changed} />,
    );

    const user = userEvent.setup();
    await user.click(screen.getByTestId("project-publish-open"));
    expect(screen.getByText("Step 1 of 2")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByText("Step 2 of 2")).toBeTruthy();

    await waitFor(() => expect(capabilityMock).toHaveBeenCalledOnce());
    expect(
      screen
        .getByRole("radio", { name: /Container backend/ })
        .hasAttribute("disabled"),
    ).toBe(true);

    const file = new File(["<h1>Live</h1>"], "index.html", {
      type: "text/html",
    });
    fireEvent.change(screen.getByTestId("project-publish-files-input"), {
      target: { files: [file] },
    });
    await user.click(screen.getByTestId("project-publish-submit"));

    await waitFor(() => expect(publishMock).toHaveBeenCalledOnce());
    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({
        project: PROJECT,
        mode: "managed-frontend",
        frontendFiles: [
          { path: "index.html", content: "PGgxPkxpdmU8L2gxPg==" },
        ],
      }),
    );
    expect(changed).toHaveBeenCalledWith(bound);
    expect(storeKeyMock).toHaveBeenCalledWith(bound.cloudAppId, "eliza_once");
    expect(notifyMock).toHaveBeenCalledWith(PROJECT.id);
  });

  it("renders a live Published state with account-level affiliate and earnings context", async () => {
    const app = makeApp();
    publication = {
      status: "published",
      app,
      publicUrl: app.app_url,
      activeDeploymentId: "deployment-1",
      liveMode: "managed-frontend",
    };
    apiMock
      .mockResolvedValueOnce({
        code: { code: "MAKER20", is_active: true },
      })
      .mockResolvedValueOnce({
        success: true,
        balance: { availableBalance: 42.5 },
      });
    const clipboardWrite = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: clipboardWrite },
    });

    render(
      <ProjectPublishPanel project={{ ...PROJECT, cloudAppId: app.id }} />,
    );

    expect(screen.getByText("Published")).toBeTruthy();
    expect(screen.getByRole("link", { name: app.app_url })).toBeTruthy();
    expect(screen.getByTestId("cloud-management-tabs")).toBeTruthy();
    expect(await screen.findByText("MAKER20")).toBeTruthy();
    expect(screen.getByText("$42.50")).toBeTruthy();
    const affiliateUrl = "https://cloud.example.test/login?affiliate=MAKER20";
    expect(screen.getByTitle(affiliateUrl).textContent).toBe(affiliateUrl);

    await userEvent.click(
      screen.getByRole("button", { name: "Copy affiliate link" }),
    );
    expect(clipboardWrite).toHaveBeenCalledWith(affiliateUrl);
    expect(
      await screen.findByRole("button", {
        name: "Affiliate link copied",
      }),
    ).toBeTruthy();

    openExternalMock.mockReturnValue(true);
    await userEvent.click(
      screen.getByRole("link", { name: "Open affiliate link" }),
    );
    expect(openExternalMock).toHaveBeenCalledWith(affiliateUrl);
  });

  it("keeps account loading and errors explicit, then retries the typed reads", async () => {
    const app = makeApp();
    publication = {
      status: "published",
      app,
      publicUrl: app.app_url,
      activeDeploymentId: "deployment-1",
      liveMode: "managed-frontend",
    };
    apiMock
      .mockRejectedValueOnce(new Error("Cloud account service is offline"))
      .mockResolvedValueOnce({
        success: true,
        balance: { availableBalance: 0 },
      });

    render(
      <ProjectPublishPanel project={{ ...PROJECT, cloudAppId: app.id }} />,
    );

    expect(screen.getByText("Loading publishing account details")).toBeTruthy();
    expect(await screen.findByText("Account context unavailable")).toBeTruthy();
    expect(screen.getByText("Cloud account service is offline")).toBeTruthy();

    apiMock
      .mockResolvedValueOnce({
        code: { code: "RECOVERED", is_active: true },
      })
      .mockResolvedValueOnce({
        success: true,
        balance: { availableBalance: 3 },
      });
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByText("RECOVERED")).toBeTruthy();
    expect(screen.getByText("$3.00")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Open affiliate link" }),
    ).toBeTruthy();
  });

  it("does not offer an inactive affiliate link as usable", async () => {
    const app = makeApp();
    publication = {
      status: "published",
      app,
      publicUrl: app.app_url,
      activeDeploymentId: "deployment-1",
      liveMode: "managed-frontend",
    };
    apiMock
      .mockResolvedValueOnce({
        code: { code: "DISABLED", is_active: false },
      })
      .mockResolvedValueOnce({
        success: true,
        balance: { availableBalance: 0 },
      });

    render(
      <ProjectPublishPanel project={{ ...PROJECT, cloudAppId: app.id }} />,
    );

    expect(await screen.findByText("Not active")).toBeTruthy();
    expect(
      screen.getByText(
        "This affiliate code is inactive, so its signup link is unavailable.",
      ),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Copy affiliate link" }),
    ).toBeNull();
    expect(
      screen.queryByRole("link", { name: "Open affiliate link" }),
    ).toBeNull();
  });

  it("surfaces a broken binding as an error with an explicit clear action", async () => {
    publication = {
      status: "error",
      error: "Cloud project was not found",
      staleBinding: true,
    };
    const unbound = { ...PROJECT };
    unbindMock.mockResolvedValue(unbound);
    const changed = vi.fn();

    render(
      <ProjectPublishPanel
        project={{ ...PROJECT, cloudAppId: "missing-app" }}
        onProjectChanged={changed}
      />,
    );

    expect(screen.getByText("Publication could not be loaded")).toBeTruthy();
    expect(screen.queryByText("Ready to publish")).toBeNull();
    await userEvent.click(
      screen.getByRole("button", { name: "Clear broken binding" }),
    );
    await waitFor(() => expect(unbindMock).toHaveBeenCalledWith(PROJECT.id));
    expect(changed).toHaveBeenCalledWith(unbound);
  });

  it("does not clear a valid binding for a transient Cloud error", () => {
    publication = {
      status: "error",
      error: "Cloud transport unavailable",
    };

    render(
      <ProjectPublishPanel
        project={{ ...PROJECT, cloudAppId: "temporarily-unavailable-app" }}
      />,
    );

    expect(screen.getByText("Publication could not be loaded")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Clear broken binding" }),
    ).toBeNull();
  });

  it("keeps unpublish non-destructive and deletes only through the explicit delete callback", async () => {
    const app = makeApp();
    const bound = { ...PROJECT, cloudAppId: app.id };
    publication = {
      status: "published",
      app,
      publicUrl: app.app_url,
      liveMode: "managed-frontend",
      activeDeploymentId: "deployment-1",
    };
    apiMock.mockResolvedValueOnce({ code: null }).mockResolvedValueOnce({
      success: true,
      balance: { availableBalance: 0 },
    });
    deleteMock.mockResolvedValue(PROJECT);
    const changed = vi.fn();

    render(<ProjectPublishPanel project={bound} onProjectChanged={changed} />);
    await userEvent.click(
      screen.getByRole("button", { name: "test unpublish" }),
    );
    await waitFor(() => expect(unpublishMock).toHaveBeenCalledWith(app.id));
    expect(deleteMock).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "test delete" }));
    await waitFor(() =>
      expect(deleteMock).toHaveBeenCalledWith(PROJECT.id, app.id),
    );
    expect(changed).toHaveBeenCalledWith(PROJECT);
  });
});
