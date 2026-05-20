import { describe, expect, it } from "vitest";
import { smartglassesControlAction } from "../actions/facewear-control.ts";
import { G1Command } from "../protocol/smartglasses.ts";
import {
  SMARTGLASSES_SERVICE_NAME,
  SmartglassesService,
} from "../services/smartglasses-service.ts";
import { MockSmartglassesTransport } from "../transport/mock.ts";

function runtimeWithService(service: SmartglassesService) {
  return {
    getService: (name: string) =>
      name === SMARTGLASSES_SERVICE_NAME ? service : null,
  };
}

async function connectedMockService() {
  const transport = new MockSmartglassesTransport();
  const service = new SmartglassesService();
  service.setTransport(transport);
  await service.connect();
  return { service, transport, runtime: runtimeWithService(service) };
}

async function runControl(
  runtime: ReturnType<typeof runtimeWithService>,
  params: Record<string, unknown>,
) {
  return smartglassesControlAction.handler(
    runtime as never,
    { content: { text: JSON.stringify(params) } } as never,
  );
}

describe("smartglasses control action", () => {
  it("returns action failures for invalid parameters instead of throwing", async () => {
    const transport = new MockSmartglassesTransport();
    const service = new SmartglassesService();
    service.setTransport(transport);
    await service.connect();

    const runtime = runtimeWithService(service);
    const callbacks: Array<{ text?: string }> = [];

    const result = await smartglassesControlAction.handler(
      runtime as never,
      { content: { text: '{"op":"brightness"}' } } as never,
      undefined,
      undefined,
      (message) => {
        callbacks.push(message);
        return Promise.resolve([]);
      },
    );

    expect(result?.success).toBe(false);
    expect(result?.text).toContain("Smartglasses brightness command failed");
    expect(result?.values).toMatchObject({
      op: "brightness",
      error: "Missing numeric parameter: level",
    });
    expect(callbacks.at(-1)?.text).toBe(result?.text);
  });

  it("requests battery status from both lenses", async () => {
    const transport = new MockSmartglassesTransport();
    const service = new SmartglassesService();
    service.setTransport(transport);
    await service.connect();

    const runtime = runtimeWithService(service);

    const result = await smartglassesControlAction.handler(
      runtime as never,
      { content: { text: '{"op":"battery_status"}' } } as never,
    );

    expect(result).toBeDefined();
    expect(result?.success).toBe(true);
    expect(transport.writes).toHaveLength(2);
    expect(transport.writes.map((write) => write.side)).toEqual([
      "left",
      "right",
    ]);
    expect(transport.writes.map((write) => Array.from(write.data))).toEqual([
      [G1Command.Battery, 0x01],
      [G1Command.Battery, 0x01],
    ]);
  });

  it("requests voice-note metadata before fetch/delete operations", async () => {
    const transport = new MockSmartglassesTransport();
    const service = new SmartglassesService();
    service.setTransport(transport);
    await service.connect();

    const runtime = runtimeWithService(service);

    const result = await smartglassesControlAction.handler(
      runtime as never,
      { content: { text: '{"op":"voice_note_list","syncId":7}' } } as never,
    );

    expect(result).toBeDefined();
    expect(result?.success).toBe(true);
    expect(result?.values?.operationResult).toEqual({ syncId: 7 });
    expect(transport.writes).toHaveLength(1);
    expect(transport.writes[0].side).toBe("right");
    expect(Array.from(transport.writes[0].data)).toEqual([
      G1Command.Note,
      0x06,
      0x00,
      0x07,
      0x01,
      0x00,
    ]);
  });

  it("routes voice-note delete-all to the QuickNote delete-all subcommand", async () => {
    const transport = new MockSmartglassesTransport();
    const service = new SmartglassesService();
    service.setTransport(transport);
    await service.connect();

    const runtime = runtimeWithService(service);

    const result = await smartglassesControlAction.handler(
      runtime as never,
      {
        content: { text: '{"op":"voice_note_delete_all","syncId":9}' },
      } as never,
    );

    expect(result).toBeDefined();
    expect(result?.success).toBe(true);
    expect(result?.values?.operationResult).toEqual({ syncId: 9 });
    expect(transport.writes).toHaveLength(1);
    expect(transport.writes[0].side).toBe("right");
    expect(Array.from(transport.writes[0].data)).toEqual([
      G1Command.Note,
      0x06,
      0x00,
      0x09,
      0x05,
      0x00,
    ]);
  });

  it("returns voice-note fetch and delete sync ids to the caller", async () => {
    const transport = new MockSmartglassesTransport();
    const service = new SmartglassesService();
    service.setTransport(transport);
    await service.connect();

    const runtime = runtimeWithService(service);

    const fetchResult = await smartglassesControlAction.handler(
      runtime as never,
      {
        content: {
          text: '{"op":"voice_note_fetch","noteIndex":3,"syncId":11}',
        },
      } as never,
    );
    const deleteResult = await smartglassesControlAction.handler(
      runtime as never,
      {
        content: {
          text: '{"op":"voice_note_delete","noteIndex":3,"syncId":12}',
        },
      } as never,
    );

    expect(fetchResult?.values?.operationResult).toEqual({ syncId: 11 });
    expect(deleteResult?.values?.operationResult).toEqual({ syncId: 12 });
    expect(transport.writes.map((write) => Array.from(write.data))).toEqual([
      [G1Command.Note, 0x06, 0x00, 0x0b, 0x02, 0x03],
      [G1Command.Note, 0x06, 0x00, 0x0c, 0x04, 0x03],
    ]);
  });

  it("returns packet counts for notification and bitmap control operations", async () => {
    const transport = new MockSmartglassesTransport();
    const service = new SmartglassesService();
    service.setTransport(transport);
    await service.connect();

    const runtime = runtimeWithService(service);

    const notificationResult = await smartglassesControlAction.handler(
      runtime as never,
      {
        content: {
          text: JSON.stringify({
            op: "notification",
            msgId: 4,
            appIdentifier: "eliza",
            title: "Eliza",
            message: "Smartglasses ready",
            timeS: 1_800_000_000,
          }),
        },
      } as never,
    );
    const bmpResult = await smartglassesControlAction.handler(
      runtime as never,
      {
        content: { text: '{"op":"bmp_image","hex":"000102030405"}' },
      } as never,
    );

    expect(notificationResult?.values?.operationResult).toEqual({ packets: 2 });
    expect(bmpResult?.values?.operationResult).toEqual({ packets: 3 });
    expect(transport.writes[0].data[0]).toBe(G1Command.Notification);
    expect(transport.writes.slice(-6).map((write) => write.data[0])).toEqual([
      G1Command.BmpData,
      G1Command.BmpData,
      G1Command.BmpEnd,
      G1Command.BmpEnd,
      G1Command.BmpCrc,
      G1Command.BmpCrc,
    ]);
  });

  it("returns packet counts for app allowlist and G1 setup operations", async () => {
    const transport = new MockSmartglassesTransport();
    const service = new SmartglassesService();
    service.setTransport(transport);
    await service.connect();

    const runtime = runtimeWithService(service);

    const appWhitelistResult = await smartglassesControlAction.handler(
      runtime as never,
      {
        content: {
          text: JSON.stringify({
            op: "app_whitelist",
            whitelist: { apps: ["eliza"] },
          }),
        },
      } as never,
    );
    const g1SetupResult = await smartglassesControlAction.handler(
      runtime as never,
      {
        content: {
          text: JSON.stringify({
            op: "g1_setup",
            data: { app: "eliza", permissions: ["display", "mic"] },
          }),
        },
      } as never,
    );

    expect(appWhitelistResult?.values?.operationResult).toEqual({
      packets: 1,
    });
    expect(g1SetupResult?.values?.operationResult).toEqual({ packets: 1 });
    expect(transport.writes.map((write) => write.data[0])).toEqual([
      G1Command.AppWhitelist,
      G1Command.AppWhitelist,
    ]);
  });

  it("returns packet counts for navigation image transfers", async () => {
    const transport = new MockSmartglassesTransport();
    const service = new SmartglassesService();
    service.setTransport(transport);
    await service.connect();

    const runtime = runtimeWithService(service);
    const image = Array.from({ length: 136 * 136 }, (_, index) =>
      index % 29 === 0 ? 1 : 0,
    );
    const overlay = Array.from({ length: 136 * 136 }, () => 0);

    const result = await smartglassesControlAction.handler(
      runtime as never,
      {
        content: {
          text: JSON.stringify({
            op: "navigation_primary_image",
            image,
            overlay,
          }),
        },
      } as never,
    );

    const operationResult = result?.values?.operationResult as
      | { packets?: number }
      | undefined;
    expect(result?.success).toBe(true);
    expect(operationResult?.packets).toBeGreaterThan(0);
    expect(transport.writes).toHaveLength((operationResult?.packets ?? 0) * 2);
    expect(
      transport.writes.every((write) => write.data[0] === G1Command.Navigation),
    ).toBe(true);
  });

  it("sends secondary navigation image transfers through both lenses", async () => {
    const transport = new MockSmartglassesTransport();
    const service = new SmartglassesService();
    service.setTransport(transport);
    await service.connect();
    const image = Array.from({ length: 488 * 136 }, (_, index) =>
      index % 137 === 0 ? 1 : 0,
    );
    const overlay = Array.from({ length: 488 * 136 }, () => 0);

    const result = await service.sendNavigationSecondaryImage(image, overlay);

    expect(result.packets).toBeGreaterThan(0);
    expect(transport.writes).toHaveLength(result.packets * 2);
    expect(
      transport.writes.every((write) => write.data[0] === G1Command.Navigation),
    ).toBe(true);
  });

  it("routes dashboard height and depth positioning through the official packet", async () => {
    const transport = new MockSmartglassesTransport();
    const service = new SmartglassesService();
    service.setTransport(transport);
    await service.connect();

    const runtime = runtimeWithService(service);

    const result = await smartglassesControlAction.handler(
      runtime as never,
      {
        content: { text: '{"op":"dashboard_position","height":3,"depth":7}' },
      } as never,
    );

    expect(result).toBeDefined();
    expect(result?.success).toBe(true);
    expect(transport.writes).toHaveLength(2);
    expect(transport.writes.map((write) => write.side)).toEqual([
      "left",
      "right",
    ]);
    expect(transport.writes.map((write) => Array.from(write.data))).toEqual([
      [G1Command.DashboardPosition, 0x08, 0x00, 0x00, 0x02, 0x01, 0x03, 0x07],
      [G1Command.DashboardPosition, 0x08, 0x00, 0x00, 0x02, 0x01, 0x03, 0x07],
    ]);
  });

  it("dispatches the full control-action G1 command surface", async () => {
    const { service, transport, runtime } = await connectedMockService();
    const monoPixels = Array.from({ length: 32 * 16 }, (_, index) =>
      index % 3 === 0 ? 255 : 0,
    );
    const commands: Array<Record<string, unknown>> = [
      { op: "connect", init: true },
      { op: "clear" },
      { op: "exit_dashboard" },
      { op: "exit_function" },
      { op: "start_ai", subcommand: "start" },
      { op: "connection_ready", mode: "official", side: "both" },
      { op: "page_up" },
      { op: "page_down" },
      {
        op: "rsvp_text",
        text: "Eliza streams readable G1 RSVP text.",
        skipDelay: true,
      },
      { op: "heartbeat", seq: 3 },
      { op: "heartbeat_start", immediate: false, intervalMs: 60_000 },
      { op: "heartbeat_stop" },
      { op: "raw", side: "left", hex: "010203" },
      { op: "get_serial", side: "right" },
      { op: "silent_mode", enabled: true },
      { op: "brightness", level: 3 },
      { op: "dashboard", enabled: true, position: 1 },
      { op: "dashboard_layout", layout: "dual" },
      {
        op: "dashboard_calendar",
        name: "Standup",
        time: "09:30",
        location: "Lab",
      },
      {
        op: "dashboard_time_weather",
        temperatureInCelsius: 21,
        weatherIcon: 2,
        temperatureUnit: "celsius",
        timeFormat: "24h",
      },
      { op: "headup_angle", angle: 8 },
      { op: "wear_detection", enabled: true },
      { op: "wifi_scan" },
      { op: "wifi_status" },
      { op: "wifi_configure", ssid: "ElizaNet", password: "secret" },
      { op: "wifi_setup", reason: "test setup" },
      { op: "navigation_start" },
      {
        op: "navigation_directions",
        totalDuration: "12 min",
        totalDistance: "0.8 mi",
        direction: "Market St",
        distance: "300 ft",
        speed: "2 mph",
        directionTurn: 2,
      },
      { op: "navigation_poller" },
      { op: "navigation_end" },
      { op: "translate_setup" },
      { op: "translate_start" },
      { op: "translate_languages", fromLanguage: 1, toLanguage: 2 },
      { op: "translate_original", text: "hello", syncId: 31 },
      { op: "translate_translated", text: "hola", syncId: 32 },
      {
        op: "note_add",
        noteNumber: 1,
        title: "Eliza",
        text: "Remember headset setup.",
      },
      { op: "note_delete", noteNumber: 1 },
      { op: "bmp_image", pixels: monoPixels, width: 32, height: 16 },
    ];

    for (const command of commands) {
      const result = await runControl(runtime, command);
      expect(result?.success, `op ${command.op as string}`).toBe(true);
      expect(result?.values?.op, `op ${command.op as string}`).toBe(command.op);
    }

    await runControl(runtime, { op: "disconnect" });

    expect(transport.writes.length).toBeGreaterThan(commands.length);
    expect(transport.wifiRequests.map((request) => request.op)).toEqual([
      "scan",
      "status",
      "configure",
      "setup",
    ]);
    expect(service.getStatus().connected).toBe(false);
  });

  it("routes setup-friendly aliases to canonical G1 operations", async () => {
    const { transport, runtime } = await connectedMockService();

    const aliasCommands: Array<Record<string, unknown>> = [
      {
        op: "app_allowlist",
        allowlist: { apps: ["eliza"] },
      },
      {
        op: "wifi_connect",
        ssid: "AliasNet",
        password: "secret",
      },
      {
        op: "request_wifi_setup",
        reason: "alias setup",
      },
      {
        op: "quick_note_list",
        syncId: 41,
      },
      {
        op: "quick_note_fetch",
        noteIndex: 2,
        syncId: 42,
      },
      {
        op: "quick_note_delete_all",
        syncId: 43,
      },
      {
        op: "previous_page",
      },
      {
        op: "next_page",
      },
    ];

    const returnedOps: unknown[] = [];
    for (const command of aliasCommands) {
      const result = await runControl(runtime, command);
      expect(result?.success, `alias ${command.op as string}`).toBe(true);
      returnedOps.push(result?.values?.op);
    }

    expect(returnedOps).toEqual([
      "app_whitelist",
      "wifi_configure",
      "wifi_setup",
      "voice_note_list",
      "voice_note_fetch",
      "voice_note_delete_all",
      "page_up",
      "page_down",
    ]);
    expect(transport.wifiRequests).toEqual([
      { op: "configure", ssid: "AliasNet", password: "secret" },
      { op: "setup", reason: "alias setup" },
    ]);
    expect(transport.writes.map((write) => write.data[0])).toContain(
      G1Command.AppWhitelist,
    );
    expect(transport.writes.map((write) => Array.from(write.data))).toEqual(
      expect.arrayContaining([
        [G1Command.Note, 0x06, 0x00, 41, 0x01, 0x00],
        [G1Command.Note, 0x06, 0x00, 42, 0x02, 0x02],
        [G1Command.Note, 0x06, 0x00, 43, 0x05, 0x00],
      ]),
    );
    expect(
      transport.writes.some(
        (write) =>
          write.side === "left" &&
          write.data[0] === G1Command.StartAi &&
          write.data[1] === 0x01,
      ),
    ).toBe(true);
    expect(
      transport.writes.some(
        (write) =>
          write.side === "right" &&
          write.data[0] === G1Command.StartAi &&
          write.data[1] === 0x01,
      ),
    ).toBe(true);
  });
});
