// @vitest-environment jsdom

/**
 * `GET /api/v1/pricing/summary` describes token-priced endpoints without a
 * `cost` (the price depends on the model). Selecting such an endpoint after
 * the live pricing arrived must render its description, not crash the page.
 */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CloudI18nProvider } from "../../shell/CloudI18nProvider";

/** Exact `chat-completions` entry of the pricing summary route. */
const livePricing = {
  "chat-completions": {
    unit: "1k tokens",
    isVariable: true,
    description:
      "Model-specific token pricing is resolved by the AI pricing catalog",
  },
};

const apiMock = vi.hoisted(() => vi.fn());
vi.mock("../../lib/api-client", () => ({ api: apiMock }));
afterEach(() => {
  cleanup();
  apiMock.mockReset();
});
vi.mock("../use-explorer-api-key", () => ({
  useExplorerApiKey: () => ({
    authToken: null,
    explorerKey: null,
    isLoading: false,
    error: null,
    refreshExplorerKey: async () => {},
    setAuthToken: () => {},
  }),
}));
vi.mock("../../lib/use-session-auth", () => ({
  useSessionAuth: () => ({ ready: true, authenticated: true, user: null }),
}));
vi.mock("../api-tester", () => ({ ApiTester: () => null }));
vi.mock("../auth-manager", () => ({ AuthManager: () => null }));
vi.mock("../../../cloud-ui/components/docs/openapi-viewer", () => ({
  OpenApiViewer: () => null,
}));

const { default: ApiExplorerRoute } = await import("../ApiExplorerPage");

it("shows the catalog note for Chat Completion once live pricing has no cost", async () => {
  apiMock.mockResolvedValue({ pricing: livePricing });
  await act(async () => {
    render(
      <CloudI18nProvider initialLang="en">
        <ApiExplorerRoute />
      </CloudI18nProvider>,
    );
  });

  // Wait for the pricing overlay to land before selecting the endpoint.
  await waitFor(() =>
    expect(screen.getAllByText("Chat Completion").length).toBeGreaterThan(0),
  );
  fireEvent.click(screen.getAllByText("Chat Completion")[0]);

  await waitFor(() =>
    expect(screen.getByText(/resolved by the AI pricing catalog/)).toBeTruthy(),
  );
});

it("updates an already open endpoint when live pricing arrives", async () => {
  let finish!: (value: { pricing: typeof livePricing }) => void;
  apiMock.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  render(
    <CloudI18nProvider initialLang="en">
      <ApiExplorerRoute />
    </CloudI18nProvider>,
  );
  fireEvent.click(await screen.findByText("Chat Completion"));
  expect(screen.queryByText(/resolved by the AI pricing catalog/)).toBeNull();
  await act(async () => {
    finish({ pricing: livePricing });
  });
  await waitFor(() =>
    expect(screen.getByText(/resolved by the AI pricing catalog/)).toBeTruthy(),
  );
});
