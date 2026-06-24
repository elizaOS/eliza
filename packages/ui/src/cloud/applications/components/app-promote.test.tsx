// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, api } from "../../lib/api-client";
import type { App } from "../lib/apps";
import { AppPromote } from "./app-promote";

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
  },
}));

vi.mock("../../shell/CloudI18nProvider", () => ({
  useCloudT:
    () =>
    (
      _key: string,
      options?: { defaultValue?: string; [key: string]: unknown },
    ) =>
      options?.defaultValue ?? _key,
}));

vi.mock("../../../cloud-ui/components/promotion/promote-app-dialog", () => ({
  PromoteAppDialog: () => null,
}));

vi.mock("../../lib/api-client", async () => {
  const actual = await vi.importActual<typeof import("../../lib/api-client")>(
    "../../lib/api-client",
  );

  return {
    ...actual,
    api: vi.fn(),
  };
});

const app = {
  id: "app-1",
  name: "Milady Promote",
} as App;

const promotionSuggestions = {
  recommendedChannels: [],
  estimatedBudget: { min: 10, max: 20 },
  suggestedPlatforms: [],
  tips: [],
};

const apiMock = vi.mocked(api);
const toastErrorMock = vi.mocked(toast.error);

function mockPromoteRequests(assetError: unknown) {
  apiMock.mockImplementation(async (path: string) => {
    if (path === "/api/v1/apps/app-1/promote") {
      return promotionSuggestions;
    }

    if (path === "/api/v1/advertising/accounts") {
      return { accounts: [] };
    }

    if (path === "/api/v1/apps/app-1/promote/assets") {
      throw assetError;
    }

    throw new Error(`Unexpected API request: ${path}`);
  });
}

async function renderPromoteTab() {
  render(
    <MemoryRouter>
      <AppPromote app={app} />
    </MemoryRouter>,
  );

  return screen.findByRole("button", { name: /generate assets/i });
}

describe("AppPromote", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("shows an insufficient credits toast when asset generation returns 402", async () => {
    mockPromoteRequests(
      new ApiError(402, "INSUFFICIENT_CREDITS", "Insufficient credits"),
    );

    const generateButton = await renderPromoteTab();
    fireEvent.click(generateButton);

    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalledWith(
        "Not enough credits to generate promotional assets.",
      );
    });
  });

  it("shows a generic failure toast when asset generation fails for another reason", async () => {
    mockPromoteRequests(new Error("server unavailable"));

    const generateButton = await renderPromoteTab();
    fireEvent.click(generateButton);

    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalledWith(
        "Failed to generate assets. Try again.",
      );
    });
  });
});
