/** Renders the English privacy policy from its authoritative message catalog. */

// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { CloudI18nProvider } from "../../../shell/CloudI18nProvider";
import PrivacyPolicyPage from "./privacy-policy-page";

afterEach(cleanup);

describe("PrivacyPolicyPage", () => {
  it("renders fail-closed deletion and support guidance from the English catalog", () => {
    render(
      <MemoryRouter>
        <CloudI18nProvider initialLang="en">
          <PrivacyPolicyPage />
        </CloudI18nProvider>
      </MemoryRouter>,
    );

    expect(
      screen.getByText(
        /checks whether a complete deletion lifecycle is available/i,
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(/https:\/\/eliza\.app\/account-deletion/i),
    ).toBeTruthy();
    expect(screen.getByText(/support@eliza\.cloud/i)).toBeTruthy();
    expect(screen.queryByText(/disable access immediately/i)).toBeNull();
  });
});
