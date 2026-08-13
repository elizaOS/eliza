/**
 * Component coverage for Knowledge availability states on web and native
 * mobile when the documents route is absent. The harness uses the real
 * DocumentsView state machine with only its transport and app context mocked.
 */
// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../api/client-types-core";
import { __resetResourceCache } from "../../hooks/resource-cache";

const appMock = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
const platformMock = vi.hoisted(() => ({ isNative: false }));
const clientMock = vi.hoisted(() => ({
  getDocumentFacetCounts: vi.fn(),
  listDocuments: vi.fn(),
}));

vi.mock("../../state", () => ({
  useAppSelector: (selector: (value: Record<string, unknown>) => unknown) =>
    selector(appMock.value),
  useTranslation: () => ({ t: appMock.value.t }),
}));
vi.mock("../../api/client", () => ({ client: clientMock }));
vi.mock("../../platform", () => ({
  get isNative() {
    return platformMock.isNative;
  },
}));
vi.mock("../../state/view-chat-binding", () => ({
  useRegisterViewChatBinding: () => {},
}));

import { DocumentsView } from "./DocumentsView";

function t(key: string, options?: { defaultValue?: string }) {
  return options?.defaultValue ?? key;
}

function missingDocumentsRoute(): ApiError {
  return new ApiError({
    kind: "http",
    path: "/api/documents",
    message: "Not Found",
    status: 404,
  });
}

beforeEach(() => {
  __resetResourceCache();
  platformMock.isNative = false;
  appMock.value = { t, setActionNotice: vi.fn() };
  clientMock.listDocuments.mockReset();
  clientMock.getDocumentFacetCounts.mockReset();
  clientMock.listDocuments.mockRejectedValue(missingDocumentsRoute());
  clientMock.getDocumentFacetCounts.mockRejectedValue(missingDocumentsRoute());
});

afterEach(() => cleanup());

describe("DocumentsView availability", () => {
  it("shows a retryable service error on web without empty-state CTAs", async () => {
    render(<DocumentsView fileInputId="knowledge-upload" />);

    expect(
      await screen.findByText(
        "Knowledge service is unavailable. Please try again.",
      ),
    ).toBeTruthy();
    expect(
      screen.queryByText(/Knowledge isn't available on this device/i),
    ).toBeNull();
    expect(screen.queryByText("No knowledge yet")).toBeNull();
    expect(screen.queryByTestId("knowledge-add")).toBeNull();
    expect(screen.getByRole("button", { name: "common.retry" })).toBeTruthy();
  });

  it("keeps the device-unavailable state for native mobile only", async () => {
    platformMock.isNative = true;
    render(<DocumentsView fileInputId="knowledge-upload" />);

    expect(
      await screen.findByText(
        "Knowledge isn't available on this device. Manage documents from the desktop or web app.",
      ),
    ).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByText("No knowledge yet")).toBeNull();
      expect(screen.queryByTestId("knowledge-add")).toBeNull();
    });
    expect(
      screen.queryByText("Knowledge service is unavailable. Please try again."),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "common.retry" })).toBeNull();
  });
});
