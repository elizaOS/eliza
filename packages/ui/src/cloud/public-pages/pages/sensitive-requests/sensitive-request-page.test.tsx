// @vitest-environment jsdom

/**
 * `SensitiveRequestPage` image/file upload (#8910): an image field renders as a
 * file input with camera capture (not filtered out) and delivers the upload as
 * a base64 data URL through the existing submit path, an over-`maxBytes` upload
 * is rejected and never submitted, and a non-image field renders without
 * forcing the camera. The router and api-client are doubled; the page is real.
 */

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- collaborator doubles (hoisted so vi.mock factories can close over them) ---

const paramsRef = vi.hoisted(() => ({ current: { requestId: "req_img_1" } }));
const locationRef = vi.hoisted(() => ({ current: { search: "?token=tok-1" } }));
vi.mock("react-router-dom", () => ({
  useParams: () => paramsRef.current,
  useLocation: () => locationRef.current,
}));

const apiMock = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/api-client", () => {
  class ApiError extends Error {
    constructor(
      public readonly status: number,
      public readonly code: string,
      message: string,
      public readonly body?: unknown,
    ) {
      super(message);
      this.name = "ApiError";
    }
  }
  return { api: apiMock, ApiError };
});

vi.mock("../../lib/use-page-title", () => ({ usePageTitle: () => {} }));

import SensitiveRequestPage from "./sensitive-request-page";

interface HostedField {
  name: string;
  label: string;
  input: string;
  required: boolean;
  mimeTypes?: string[];
  maxBytes?: number;
}

function imageRequest(overrides?: Partial<HostedField>) {
  return {
    id: "req_img_1",
    kind: "secret" as const,
    status: "pending" as const,
    reason: "Photograph the 2FA seed",
    form: {
      submitLabel: "Upload",
      fields: [
        {
          name: "seed_photo",
          label: "Seed photo",
          input: "image",
          required: true,
          mimeTypes: ["image/png"],
          maxBytes: 1_000_000,
          ...overrides,
        },
      ],
    },
  };
}

/** Load returns the request; the POST submit resolves and is captured. */
function primeApi(request: unknown) {
  const submits: Array<{ path: string; body: unknown }> = [];
  apiMock.mockImplementation(
    async (path: string, opts?: { method?: string; json?: unknown }) => {
      if (opts?.method === "POST") {
        submits.push({ path, body: opts.json });
        return { ok: true };
      }
      return request;
    },
  );
  return submits;
}

describe("SensitiveRequestPage — image/file upload (#8910)", () => {
  afterEach(() => cleanup());
  beforeEach(() => {
    apiMock.mockReset();
    paramsRef.current = { requestId: "req_img_1" };
    locationRef.current = { search: "?token=tok-1" };
  });

  it("renders an image field as a file input (not filtered out) with camera capture", async () => {
    primeApi(imageRequest());
    render(<SensitiveRequestPage />);

    const input = (await screen.findByTestId(
      "sensitive-request-file-seed_photo",
    )) as HTMLInputElement;
    expect(input.type).toBe("file");
    expect(input.accept).toBe("image/png");
    expect(input.getAttribute("capture")).toBe("environment");
  });

  it("delivers the uploaded image as a base64 data URL through the existing submit path", async () => {
    const submits = primeApi(imageRequest());
    render(<SensitiveRequestPage />);

    const input = (await screen.findByTestId(
      "sensitive-request-file-seed_photo",
    )) as HTMLInputElement;
    const file = new File([new Uint8Array([1, 2, 3])], "seed.png", {
      type: "image/png",
    });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      expect(
        (screen.getByRole("button", { name: /upload/i }) as HTMLButtonElement)
          .disabled,
      ).toBe(false);
    });
    fireEvent.click(screen.getByRole("button", { name: /upload/i }));

    await waitFor(() => expect(submits).toHaveLength(1));
    const body = submits[0]?.body as { token?: string; value?: string };
    expect(body.token).toBe("tok-1");
    expect(body.value?.startsWith("data:image/png")).toBe(true);
  });

  it("rejects an upload over maxBytes and never submits", async () => {
    const submits = primeApi(imageRequest({ maxBytes: 3 }));
    render(<SensitiveRequestPage />);

    const input = (await screen.findByTestId(
      "sensitive-request-file-seed_photo",
    )) as HTMLInputElement;
    const valid = new File([new Uint8Array([1, 2, 3])], "ok.png", {
      type: "image/png",
    });
    fireEvent.change(input, { target: { files: [valid] } });
    await waitFor(() => {
      expect(
        (screen.getByRole("button", { name: /upload/i }) as HTMLButtonElement)
          .disabled,
      ).toBe(false);
    });

    const tooBig = new File([new Uint8Array([1, 2, 3, 4])], "big.png", {
      type: "image/png",
    });
    fireEvent.change(input, { target: { files: [tooBig] } });

    await waitFor(() => expect(screen.getByText(/too large/i)).toBeTruthy());
    expect(
      (screen.getByRole("button", { name: /upload/i }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /upload/i }));
    expect(submits).toHaveLength(0);
  });

  it("renders a non-image file field without forcing the camera", async () => {
    primeApi(
      imageRequest({
        name: "backup",
        label: "Backup file",
        input: "file",
        mimeTypes: ["application/json"],
      }),
    );
    render(<SensitiveRequestPage />);

    const input = (await screen.findByTestId(
      "sensitive-request-file-backup",
    )) as HTMLInputElement;
    expect(input.type).toBe("file");
    expect(input.accept).toBe("application/json");
    expect(input.getAttribute("capture")).toBeNull();
  });
});
