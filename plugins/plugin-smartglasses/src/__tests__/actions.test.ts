import type { Memory } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { smartglassesControlAction } from "../actions/control.js";
import { displaySmartglassesTextAction } from "../actions/display-text.js";
import { smartglassesMicrophoneAction } from "../actions/microphone.js";
import { smartglassesStatusAction } from "../actions/status.js";
import { G1Command, G1ScreenAction, G1TextStatus } from "../protocol.js";
import {
  SMARTGLASSES_SERVICE_NAME,
  SmartglassesService,
} from "../services/smartglasses-service.js";
import { MockSmartglassesTransport } from "../transport/mock.js";

function memory(text: string): Memory {
  return { content: { text } } as Memory;
}

function expectResult(result: unknown): asserts result is {
  success: boolean;
  text?: string;
} {
  expect(result).toBeTruthy();
}

function runtimeWith(service: SmartglassesService) {
  return {
    getService: (name: string) =>
      name === SMARTGLASSES_SERVICE_NAME ? service : null,
  } as never;
}

describe("smartglasses actions", () => {
  it("routes display, mic, control, and status through the service", async () => {
    const transport = new MockSmartglassesTransport();
    const service = new SmartglassesService();
    service.setTransport(transport);
    const runtime = runtimeWith(service);
    const callbackTexts: string[] = [];
    const callback = async ({ text }: { text?: string }) => {
      if (text) callbackTexts.push(text);
    };

    const displayResult = await displaySmartglassesTextAction.handler(
      runtime,
      memory('{"text":"hello glasses"}'),
      undefined,
      undefined,
      callback as never,
    );
    expectResult(displayResult);
    expect(displayResult.success).toBe(true);
    expect(
      transport.writes.some((write) => write.data[0] === G1Command.SendResult),
    ).toBe(true);

    const textModeResult = await displaySmartglassesTextAction.handler(
      runtime,
      memory('{"text":"direct text mode","mode":"text"}'),
      undefined,
      undefined,
      callback as never,
    );
    expectResult(textModeResult);
    expect(textModeResult.success).toBe(true);
    expect(transport.writes.at(-1)?.data[4]).toBe(
      G1TextStatus.TextShow | G1ScreenAction.NewContent,
    );

    const micResult = await smartglassesMicrophoneAction.handler(
      runtime,
      memory("enable microphone"),
      undefined,
      undefined,
      callback as never,
    );
    expectResult(micResult);
    expect(micResult.success).toBe(true);
    expect(Array.from(transport.writes.at(-1)?.data ?? [])).toEqual([
      G1Command.OpenMic,
      1,
    ]);

    const controlResult = await smartglassesControlAction.handler(
      runtime,
      memory('{"op":"brightness","level":5,"auto":true}'),
      undefined,
      undefined,
      callback as never,
    );
    expectResult(controlResult);
    expect(controlResult.success).toBe(true);
    expect(
      transport.writes.some((write) => write.data[0] === G1Command.Brightness),
    ).toBe(true);

    const heartbeatResult = await smartglassesControlAction.handler(
      runtime,
      memory('{"op":"heartbeat"}'),
      undefined,
      undefined,
      callback as never,
    );
    expectResult(heartbeatResult);
    expect(heartbeatResult.success).toBe(true);
    expect(
      transport.writes.some((write) => write.data[0] === G1Command.Heartbeat),
    ).toBe(true);

    const secondHeartbeatResult = await smartglassesControlAction.handler(
      runtime,
      memory('{"op":"heartbeat"}'),
      undefined,
      undefined,
      callback as never,
    );
    expectResult(secondHeartbeatResult);
    expect(secondHeartbeatResult.success).toBe(true);
    expect(
      transport.writes
        .filter((write) => write.data[0] === G1Command.Heartbeat)
        .map((write) => write.data[3]),
    ).toEqual([0, 0, 1, 1]);

    const startHeartbeatLoopResult = await smartglassesControlAction.handler(
      runtime,
      memory('{"op":"heartbeat_start","intervalMs":20}'),
      undefined,
      undefined,
      callback as never,
    );
    expectResult(startHeartbeatLoopResult);
    expect(startHeartbeatLoopResult.success).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(service.getStatus().heartbeatRunning).toBe(true);

    const stopHeartbeatLoopResult = await smartglassesControlAction.handler(
      runtime,
      memory('{"op":"heartbeat_stop"}'),
      undefined,
      undefined,
      callback as never,
    );
    expectResult(stopHeartbeatLoopResult);
    expect(stopHeartbeatLoopResult.success).toBe(true);
    expect(service.getStatus().heartbeatRunning).toBe(false);

    const exitResult = await smartglassesControlAction.handler(
      runtime,
      memory('{"op":"exit_dashboard"}'),
      undefined,
      undefined,
      callback as never,
    );
    expectResult(exitResult);
    expect(exitResult.success).toBe(true);
    expect(
      transport.writes.some((write) => write.data[0] === G1Command.StartAi),
    ).toBe(true);

    const exitFunctionResult = await smartglassesControlAction.handler(
      runtime,
      memory('{"op":"exit_function"}'),
      undefined,
      undefined,
      callback as never,
    );
    expectResult(exitFunctionResult);
    expect(exitFunctionResult.success).toBe(true);
    expect(
      transport.writes.some(
        (write) => write.data[0] === G1Command.ExitFunction,
      ),
    ).toBe(true);

    const connectionReadyResult = await smartglassesControlAction.handler(
      runtime,
      memory('{"op":"connection_ready"}'),
      undefined,
      undefined,
      callback as never,
    );
    expectResult(connectionReadyResult);
    expect(connectionReadyResult.success).toBe(true);
    expect(
      transport.writes.slice(-2).map((write) => Array.from(write.data)),
    ).toEqual([
      [G1Command.Init, 0x01],
      [G1Command.RightInit, 0x01],
    ]);

    const officialConnectionReadyResult =
      await smartglassesControlAction.handler(
        runtime,
        memory('{"op":"connection_ready","initMode":"official"}'),
        undefined,
        undefined,
        callback as never,
      );
    expectResult(officialConnectionReadyResult);
    expect(officialConnectionReadyResult.success).toBe(true);
    expect(
      transport.writes.slice(-2).map((write) => Array.from(write.data)),
    ).toEqual([
      [G1Command.Init, 0x01],
      [G1Command.Init, 0x01],
    ]);

    const serialResult = await smartglassesControlAction.handler(
      runtime,
      memory('{"op":"get_serial","side":"right"}'),
      undefined,
      undefined,
      callback as never,
    );
    expectResult(serialResult);
    expect(serialResult.success).toBe(true);
    expect(
      transport.writes.some(
        (write) =>
          write.side === "right" && write.data[0] === G1Command.GetSerial,
      ),
    ).toBe(true);

    const whitelistResult = await smartglassesControlAction.handler(
      runtime,
      memory('{"op":"app_whitelist","whitelist":{"apps":["eliza"]}}'),
      undefined,
      undefined,
      callback as never,
    );
    expectResult(whitelistResult);
    expect(whitelistResult.success).toBe(true);
    expect(
      transport.writes.some(
        (write) =>
          write.side === "left" && write.data[0] === G1Command.AppWhitelist,
      ),
    ).toBe(true);

    const setupResult = await smartglassesControlAction.handler(
      runtime,
      memory('{"op":"g1_setup","json":{"calendar_enable":true}}'),
      undefined,
      undefined,
      callback as never,
    );
    expectResult(setupResult);
    expect(setupResult.success).toBe(true);
    expect(
      transport.writes.some(
        (write) =>
          write.side === "left" && write.data[0] === G1Command.AppWhitelist,
      ),
    ).toBe(true);

    const dashboardLayoutResult = await smartglassesControlAction.handler(
      runtime,
      memory('{"op":"dashboard_layout","layout":"dual"}'),
      undefined,
      undefined,
      callback as never,
    );
    expectResult(dashboardLayoutResult);
    expect(dashboardLayoutResult.success).toBe(true);
    expect(transport.writes.at(-1)?.data[0]).toBe(G1Command.DashboardContent);

    const dashboardCalendarResult = await smartglassesControlAction.handler(
      runtime,
      memory(
        '{"op":"dashboard_calendar","name":"Test G1","time":"13:30-14:30","location":"Home"}',
      ),
      undefined,
      undefined,
      callback as never,
    );
    expectResult(dashboardCalendarResult);
    expect(dashboardCalendarResult.success).toBe(true);
    expect(transport.writes.at(-1)?.data[0]).toBe(G1Command.DashboardContent);

    const dashboardTimeResult = await smartglassesControlAction.handler(
      runtime,
      memory(
        '{"op":"dashboard_time_weather","seqId":1,"timestampMs":1700000000000,"timezoneOffsetSeconds":0,"temperatureInCelsius":21,"weatherIcon":16,"temperatureUnit":"fahrenheit","timeFormat":"12h"}',
      ),
      undefined,
      undefined,
      callback as never,
    );
    expectResult(dashboardTimeResult);
    expect(dashboardTimeResult.success).toBe(true);
    expect(transport.writes.at(-1)?.data[4]).toBe(0x01);

    const navigationResult = await smartglassesControlAction.handler(
      runtime,
      memory('{"op":"navigation_start"}'),
      undefined,
      undefined,
      callback as never,
    );
    expectResult(navigationResult);
    expect(navigationResult.success).toBe(true);
    expect(transport.writes.at(-1)?.data[0]).toBe(G1Command.Navigation);

    const navigationDirectionsResult = await smartglassesControlAction.handler(
      runtime,
      memory(
        '{"op":"navigation_directions","totalDuration":"4 min","totalDistance":"1 km","direction":"Main St","distance":"200 m","speed":"30","directionTurn":3}',
      ),
      undefined,
      undefined,
      callback as never,
    );
    expectResult(navigationDirectionsResult);
    expect(navigationDirectionsResult.success).toBe(true);
    expect(transport.writes.at(-1)?.data[4]).toBe(0x01);

    const navigationPollerResult = await smartglassesControlAction.handler(
      runtime,
      memory('{"op":"navigation_poller"}'),
      undefined,
      undefined,
      callback as never,
    );
    expectResult(navigationPollerResult);
    expect(navigationPollerResult.success).toBe(true);
    expect(transport.writes.at(-1)?.data[4]).toBe(0x04);

    const navigationEndResult = await smartglassesControlAction.handler(
      runtime,
      memory('{"op":"navigation_end"}'),
      undefined,
      undefined,
      callback as never,
    );
    expectResult(navigationEndResult);
    expect(navigationEndResult.success).toBe(true);
    expect(transport.writes.at(-1)?.data[4]).toBe(0x05);

    const translateResult = await smartglassesControlAction.handler(
      runtime,
      memory('{"op":"translate_setup"}'),
      undefined,
      undefined,
      callback as never,
    );
    expectResult(translateResult);
    expect(translateResult.success).toBe(true);
    expect(transport.writes.at(-1)?.data[0]).toBe(G1Command.TranslateSetup);

    const translateStartResult = await smartglassesControlAction.handler(
      runtime,
      memory('{"op":"translate_start"}'),
      undefined,
      undefined,
      callback as never,
    );
    expectResult(translateStartResult);
    expect(translateStartResult.success).toBe(true);
    expect(transport.writes.at(-1)).toMatchObject({ side: "right" });

    const translateLanguagesResult = await smartglassesControlAction.handler(
      runtime,
      memory('{"op":"translate_languages","fromLanguage":2,"toLanguage":5}'),
      undefined,
      undefined,
      callback as never,
    );
    expectResult(translateLanguagesResult);
    expect(translateLanguagesResult.success).toBe(true);
    expect(transport.writes.at(-1)?.data[0]).toBe(G1Command.TranslateLanguages);

    const translateTextResult = await smartglassesControlAction.handler(
      runtime,
      memory('{"op":"translate_translated","text":"bonjour","syncId":3}'),
      undefined,
      undefined,
      callback as never,
    );
    expectResult(translateTextResult);
    expect(translateTextResult.success).toBe(true);
    expect(transport.writes.at(-1)?.data[0]).toBe(
      G1Command.TranslateTranslatedText,
    );

    const rawResult = await smartglassesControlAction.handler(
      runtime,
      memory('{"op":"raw","side":"left","data":[77,1]}'),
      undefined,
      undefined,
      callback as never,
    );
    expectResult(rawResult);
    expect(rawResult.success).toBe(true);
    expect(transport.writes.at(-1)).toMatchObject({ side: "left" });
    expect(Array.from(transport.writes.at(-1)?.data ?? [])).toEqual([77, 1]);

    const pageUpResult = await smartglassesControlAction.handler(
      runtime,
      memory('{"op":"page_up"}'),
      undefined,
      undefined,
      callback as never,
    );
    expectResult(pageUpResult);
    expect(pageUpResult.success).toBe(true);
    expect(transport.writes.at(-1)).toMatchObject({
      side: "left",
    });
    expect(Array.from(transport.writes.at(-1)?.data ?? [])).toEqual([
      G1Command.StartAi,
      0x01,
    ]);

    const pageDownResult = await smartglassesControlAction.handler(
      runtime,
      memory('{"op":"page_down"}'),
      undefined,
      undefined,
      callback as never,
    );
    expectResult(pageDownResult);
    expect(pageDownResult.success).toBe(true);
    expect(transport.writes.at(-1)).toMatchObject({
      side: "right",
    });
    expect(Array.from(transport.writes.at(-1)?.data ?? [])).toEqual([
      G1Command.StartAi,
      0x01,
    ]);

    const rsvpResult = await smartglassesControlAction.handler(
      runtime,
      memory(
        '{"op":"rsvp_text","text":"scan this quickly","wordsPerGroup":2,"mode":"text","skipDelay":true}',
      ),
      undefined,
      undefined,
      callback as never,
    );
    expectResult(rsvpResult);
    expect(rsvpResult.success).toBe(true);
    expect(
      transport.writes
        .filter((write) => write.data[0] === G1Command.SendResult)
        .some(
          (write) =>
            write.data[4] ===
            (G1TextStatus.TextShow | G1ScreenAction.NewContent),
        ),
    ).toBe(true);

    const voiceNoteFetchResult = await smartglassesControlAction.handler(
      runtime,
      memory('{"op":"voice_note_fetch","noteIndex":1,"syncId":2}'),
      undefined,
      undefined,
      callback as never,
    );
    expectResult(voiceNoteFetchResult);
    expect(voiceNoteFetchResult.success).toBe(true);
    expect(Array.from(transport.writes.at(-1)?.data ?? [])).toEqual([
      G1Command.Note,
      0x06,
      0x00,
      0x02,
      0x02,
      0x01,
    ]);

    const voiceNoteDeleteResult = await smartglassesControlAction.handler(
      runtime,
      memory('{"op":"voice_note_delete","noteIndex":1,"syncId":3}'),
      undefined,
      undefined,
      callback as never,
    );
    expectResult(voiceNoteDeleteResult);
    expect(voiceNoteDeleteResult.success).toBe(true);
    expect(Array.from(transport.writes.at(-1)?.data ?? [])).toEqual([
      G1Command.Note,
      0x06,
      0x00,
      0x03,
      0x04,
      0x01,
    ]);

    const bmpResult = await smartglassesControlAction.handler(
      runtime,
      memory('{"op":"bmp_image","hex":"010203"}'),
      undefined,
      undefined,
      callback as never,
    );
    expectResult(bmpResult);
    expect(bmpResult.success).toBe(true);
    expect(
      transport.writes.some((write) => write.data[0] === G1Command.BmpData),
    ).toBe(true);

    const generatedBmpResult = await smartglassesControlAction.handler(
      runtime,
      memory('{"op":"bmp_image","pixels":[0,255,255,0],"width":2,"height":2}'),
      undefined,
      undefined,
      callback as never,
    );
    expectResult(generatedBmpResult);
    expect(generatedBmpResult.success).toBe(true);
    expect(
      transport.writes.some(
        (write) =>
          write.data[0] === G1Command.BmpData &&
          write.data[6] === 0x42 &&
          write.data[7] === 0x4d,
      ),
    ).toBe(true);

    const notificationResult = await smartglassesControlAction.handler(
      runtime,
      memory(
        '{"op":"notification","msgId":9,"type":2,"appIdentifier":"eliza","title":"Title","message":"Message","timeS":1700000000,"date":"2023-11-14 22:13:20"}',
      ),
      undefined,
      undefined,
      callback as never,
    );
    expectResult(notificationResult);
    expect(notificationResult.success).toBe(true);
    const notificationPacket = transport.writes.find(
      (write) => write.data[0] === G1Command.Notification,
    );
    expect(notificationPacket?.data[1]).toBe(9);

    service.receiveTranscript("status transcript", true);
    const statusResult = await smartglassesStatusAction.handler(
      runtime,
      memory("status"),
    );
    expectResult(statusResult);
    expect(statusResult.success).toBe(true);
    expect(statusResult.text).toContain("connected: true");
    expect(statusResult.text).toContain("lastTranscript: status transcript");
    expect(callbackTexts).toContain("Smartglasses microphone enabled.");
  });
});
