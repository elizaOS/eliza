import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { NetworkHomePage } from "../network-home/NetworkHomePage";
import {
  NETWORK_HOME_COPY,
  NETWORK_HOME_COPY_STATUS,
  NETWORK_LINE_E164,
  networkLineSmsHref,
} from "../network-home/network-home-copy";
import { isNetworkHomeEnabled } from "../network-home/network-home-flag";

describe("network home flag", () => {
  it("is off unless VITE_NETWORK_HOME is exactly '1'", () => {
    expect(isNetworkHomeEnabled(undefined)).toBe(false);
    expect(isNetworkHomeEnabled({})).toBe(false);
    expect(isNetworkHomeEnabled({ VITE_NETWORK_HOME: "0" })).toBe(false);
    expect(isNetworkHomeEnabled({ VITE_NETWORK_HOME: "true" })).toBe(false);
    expect(isNetworkHomeEnabled({ VITE_NETWORK_HOME: "1" })).toBe(true);
  });
});

describe("network home copy", () => {
  it("stays a draft until the founder approves the wording", () => {
    expect(NETWORK_HOME_COPY_STATUS).toBe("DRAFT");
  });

  it("links ntwrk.party and every app over https", () => {
    expect(NETWORK_HOME_COPY.networkHref).toBe("https://ntwrk.party");
    expect(NETWORK_HOME_COPY.apps.map((a) => a.href)).toEqual([
      "https://slop.date",
      "https://friends.help",
      "https://peon.biz",
    ]);
  });

  it("tells existing users nothing changes without consent and how to stop", () => {
    expect(NETWORK_HOME_COPY.existingUsersBody).toMatch(/consent/);
    expect(NETWORK_HOME_COPY.existingUsersBody).toMatch(/STOP/);
  });

  it("texts the shared production line", () => {
    expect(networkLineSmsHref()).toBe(`sms:${NETWORK_LINE_E164}`);
  });
});

describe("NetworkHomePage", () => {
  it("renders the Text Eliza CTA and the app links", () => {
    render(<NetworkHomePage />);
    const cta = screen.getByRole("link", { name: "Text Eliza" });
    expect(cta.getAttribute("href")).toBe(networkLineSmsHref());
    expect(
      screen
        .getByRole("link", { name: "What is The Network?" })
        .getAttribute("href"),
    ).toBe("https://ntwrk.party");
    for (const app of NETWORK_HOME_COPY.apps) {
      expect(screen.getByText(app.name)).toBeTruthy();
    }
    expect(screen.getByText(NETWORK_HOME_COPY.appsHeading)).toBeTruthy();
  });
});
