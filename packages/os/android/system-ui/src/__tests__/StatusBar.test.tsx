import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StatusBar } from "../components/StatusBar";
import { MockSystemProvider } from "../providers/MockSystemProvider";

describe("StatusBar", () => {
  it("renders indicators from MockSystemProvider", () => {
    render(
      <MockSystemProvider
        locale="en-US"
        timeZone="UTC"
        tickMs={60_000}
        initialBattery={{ percent: 78, charging: true }}
        initialWifi={{ connected: true, ssid: "eliza-home" }}
        initialAudio={{ level: 0.55, muted: false }}
        initialCell={{ strengthBars: 4, carrier: "T-Mobile", airplaneMode: false }}
      >
        <StatusBar />
      </MockSystemProvider>,
    );

    expect(screen.getByLabelText(/Wi-Fi/)).toBeDefined();
    expect(screen.getByLabelText(/T-Mobile 4\/5/)).toBeDefined();
    expect(screen.getByLabelText(/Audio/)).toBeDefined();
    expect(screen.getByLabelText(/Battery 78%/)).toBeDefined();
  });

  it("renders an HH:MM clock string", () => {
    render(
      <MockSystemProvider locale="en-US" timeZone="UTC" tickMs={60_000}>
        <StatusBar />
      </MockSystemProvider>,
    );
    const clockEls = screen.getAllByLabelText(/Time \d{2}:\d{2}/);
    expect(clockEls.length).toBeGreaterThan(0);
  });
});
