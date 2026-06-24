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
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, api } from "../../lib/api-client";
import { CloudI18nProvider } from "../../shell/CloudI18nProvider";
import type { App } from "../lib/apps";
import { AppPromote } from "./app-promote";

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
  },
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
  name: "LaunchPad",
} as App;

const suggestions = {
  recommendedChannels: ["social"],
  estimatedBudget: { min: 10, max: 25 },
  suggestedPlatforms: ["x"],
  tips: ["Post launch clips"],
};

function renderPromote() {
  render(
    <MemoryRouter>
      <CloudI18nProvider initialLang="en">
        <AppPromote app={app} />
      </CloudI18nProvider>
    </MemoryRouter>,
  );
}

const apiMock = vi.mocked(api);
const toastErrorMock = vi.mocked(toast.error);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AppPromote asset generation", () => {
  it("surfaces insufficient-credit failures", async () => {
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/v1/apps/app-1/promote") return suggestions;
      if (path === "/api/v1/advertising/accounts") return { accounts: [] };
      if (path === "/api/v1/apps/app-1/promote/assets") {
        throw new ApiError(402, "INSUFFICIENT_CREDITS", "Insufficient Credits");
      }
      throw new Error(`Unexpected API path: ${path}`);
    });

    renderPromote();

    fireEvent.click(
      await screen.findByRole("button", { name: /generate assets/i }),
    );

    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalledWith(
        "Insufficient credits to generate assets.",
      );
    });
  });

  it("surfaces generic generation failures", async () => {
    apiMock.mockImplementation(async (path) => {
      if (path === "/api/v1/apps/app-1/promote") return suggestions;
      if (path === "/api/v1/advertising/accounts") return { accounts: [] };
      if (path === "/api/v1/apps/app-1/promote/assets") {
        throw new ApiError(500, "SERVER_ERROR", "Server error");
      }
      throw new Error(`Unexpected API path: ${path}`);
    });

    renderPromote();

    fireEvent.click(
      await screen.findByRole("button", { name: /generate assets/i }),
    );

    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalledWith(
        "Failed to generate assets. Try again.",
      );
    });
  });
});
