// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useDocumentTitle } from "../lib/use-document-title";

// The shared page shell resolves titles through the cloud i18n hook; mock it to
// return the provided defaultValue so the assertions read the literal copy.
vi.mock("./CloudI18nProvider", () => ({
  useCloudT: () => (key: string, options?: { defaultValue?: string }) =>
    options?.defaultValue ?? key,
}));

import { ConsolePage } from "./ConsolePage";

describe("ConsolePage", () => {
  afterEach(() => {
    document.title = "";
  });

  it("wraps children in the shared max-width console container", () => {
    const { container } = render(
      <ConsolePage>
        <div>surface body</div>
      </ConsolePage>,
    );
    expect(screen.getByText("surface body")).toBeTruthy();
    const shell = container.firstElementChild;
    expect(shell?.className).toContain("max-w-4xl");
    expect(shell?.className).toContain("mx-auto");
  });

  it("sets the document title from titleKey/titleDefault while mounted", () => {
    render(
      <ConsolePage titleKey="cloud.billing.metaTitle" titleDefault="Billing">
        <div>billing body</div>
      </ConsolePage>,
    );
    expect(document.title).toBe("Billing");
  });

  it("restores the previous document title on unmount", () => {
    document.title = "Previous";
    const { unmount } = render(
      <ConsolePage titleKey="cloud.security.metaTitle" titleDefault="Security">
        <div>security body</div>
      </ConsolePage>,
    );
    expect(document.title).toBe("Security");
    unmount();
    expect(document.title).toBe("Previous");
  });

  it("leaves the document title untouched when no titleKey is given", () => {
    document.title = "Owned by surface";
    render(
      <ConsolePage>
        <div>api-keys body</div>
      </ConsolePage>,
    );
    // Title-less pages (the surface owns document.title) must never mount the
    // title effect, so the existing title is preserved verbatim.
    expect(document.title).toBe("Owned by surface");
  });

  it("keeps the console page title authoritative when a child surface also sets a title", () => {
    function SurfaceWithOwnTitle() {
      useDocumentTitle("Surface-owned title");
      return <div>security body</div>;
    }

    render(
      <ConsolePage titleKey="cloud.security.metaTitle" titleDefault="Security">
        <SurfaceWithOwnTitle />
      </ConsolePage>,
    );

    expect(document.title).toBe("Security");
  });
});
