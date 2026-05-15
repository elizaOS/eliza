import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TopBar } from "../components/TopBar";
import { MockSystemProvider } from "../providers/MockSystemProvider";

describe("TopBar", () => {
  it("renders indicators from MockSystemProvider", () => {
    render(
      <MockSystemProvider
        locale="en-US"
        timeZone="UTC"
        tickMs={60_000}
        initialBattery={{ percent: 94, charging: false }}
        initialWifi={{ connected: true, ssid: "eliza-home" }}
        initialAudio={{ level: 0.6, muted: false }}
      >
        <TopBar />
      </MockSystemProvider>,
    );

    expect(screen.getByLabelText(/Wi-Fi/)).toBeDefined();
    expect(screen.getByLabelText(/Audio/)).toBeDefined();
    expect(screen.getByLabelText(/Battery 94%/)).toBeDefined();
    expect(screen.getByLabelText(/Power menu/)).toBeDefined();
    expect(screen.getByLabelText(/Open settings/)).toBeDefined();
  });

  it("renders an HH:MM clock string", () => {
    render(
      <MockSystemProvider locale="en-US" timeZone="UTC" tickMs={60_000}>
        <TopBar />
      </MockSystemProvider>,
    );
    const clockEls = screen.getAllByLabelText(/Time \d{2}:\d{2}/);
    expect(clockEls.length).toBeGreaterThan(0);
  });
});
