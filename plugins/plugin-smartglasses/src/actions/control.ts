import {
  type Action,
  type ActionResult,
  type HandlerCallback,
  type HandlerOptions,
  type IAgentRuntime,
  type Memory,
  parseJSONObjectFromText,
  type State,
} from "@elizaos/core";
import {
  type G1ConnectionReadyMode,
  G1DashboardLayout,
  G1SubCommand,
  G1TemperatureUnit,
  G1TimeFormat,
} from "../protocol.js";
import { getSmartglassesService } from "../services/smartglasses-service.js";

type SmartglassesControlOp =
  | "clear"
  | "exit_dashboard"
  | "exit_function"
  | "start_ai"
  | "connection_ready"
  | "page_up"
  | "page_down"
  | "rsvp_text"
  | "heartbeat"
  | "heartbeat_start"
  | "heartbeat_stop"
  | "raw"
  | "get_serial"
  | "app_whitelist"
  | "g1_setup"
  | "silent_mode"
  | "brightness"
  | "dashboard"
  | "dashboard_layout"
  | "dashboard_calendar"
  | "dashboard_time_weather"
  | "headup_angle"
  | "wear_detection"
  | "navigation_start"
  | "navigation_directions"
  | "navigation_primary_image"
  | "navigation_secondary_image"
  | "navigation_poller"
  | "navigation_end"
  | "translate_setup"
  | "translate_start"
  | "translate_languages"
  | "translate_original"
  | "translate_translated"
  | "note_add"
  | "note_delete"
  | "voice_note_fetch"
  | "voice_note_delete"
  | "notification"
  | "bmp_image";

const SUPPORTED_OPS: SmartglassesControlOp[] = [
  "clear",
  "exit_dashboard",
  "exit_function",
  "start_ai",
  "connection_ready",
  "page_up",
  "page_down",
  "rsvp_text",
  "heartbeat",
  "heartbeat_start",
  "heartbeat_stop",
  "raw",
  "get_serial",
  "app_whitelist",
  "g1_setup",
  "silent_mode",
  "brightness",
  "dashboard",
  "dashboard_layout",
  "dashboard_calendar",
  "dashboard_time_weather",
  "headup_angle",
  "wear_detection",
  "navigation_start",
  "navigation_directions",
  "navigation_primary_image",
  "navigation_secondary_image",
  "navigation_poller",
  "navigation_end",
  "translate_setup",
  "translate_start",
  "translate_languages",
  "translate_original",
  "translate_translated",
  "note_add",
  "note_delete",
  "voice_note_fetch",
  "voice_note_delete",
  "notification",
  "bmp_image",
];

const OP_ALIASES = new Map<string, SmartglassesControlOp>([
  ["exit", "exit_dashboard"],
  ["dashboard_exit", "exit_dashboard"],
  ["function_exit", "exit_function"],
  ["serial", "get_serial"],
  ["whitelist", "app_whitelist"],
  ["app_allowlist", "app_whitelist"],
  ["setup", "g1_setup"],
  ["app_setup", "g1_setup"],
  ["dashboard_calendar_item", "dashboard_calendar"],
  ["time_weather", "dashboard_time_weather"],
  ["navigation_init", "navigation_start"],
  ["navigation_direction", "navigation_directions"],
  ["navigation_primary", "navigation_primary_image"],
  ["navigation_secondary", "navigation_secondary_image"],
  ["navigation_stop", "navigation_end"],
  ["translate", "translate_setup"],
  ["translation_setup", "translate_setup"],
  ["translate_text", "translate_translated"],
  ["start_even_ai", "start_ai"],
  ["init", "connection_ready"],
  ["initialize", "connection_ready"],
  ["connection_init", "connection_ready"],
  ["ready", "connection_ready"],
  ["previous_page", "page_up"],
  ["prev_page", "page_up"],
  ["next_page", "page_down"],
  ["start_heartbeat", "heartbeat_start"],
  ["heartbeat_loop", "heartbeat_start"],
  ["stop_heartbeat", "heartbeat_stop"],
  ["rsvp", "rsvp_text"],
  ["rsvp_display", "rsvp_text"],
  ["bmp", "bmp_image"],
  ["image", "bmp_image"],
  ["quick_note_fetch", "voice_note_fetch"],
  ["quick_note_delete", "voice_note_delete"],
  ["voice_note_audio", "voice_note_fetch"],
]);

function parseParams(message: Memory): Record<string, unknown> {
  const text = (message.content as { text?: string } | undefined)?.text ?? "";
  return (
    (parseJSONObjectFromText(text) as Record<string, unknown> | null) ?? {
      op: text.trim(),
    }
  );
}

function requireOp(value: unknown): SmartglassesControlOp | null {
  if (typeof value !== "string") return null;
  const normalized = value
    .trim()
    .replace(/[\s-]+/g, "_")
    .toLowerCase();
  const alias = OP_ALIASES.get(normalized);
  if (alias) return alias;
  return SUPPORTED_OPS.includes(normalized as SmartglassesControlOp)
    ? (normalized as SmartglassesControlOp)
    : null;
}

function numberParam(params: Record<string, unknown>, name: string): number {
  const value = params[name];
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed))
    throw new Error(`Missing numeric parameter: ${name}`);
  return parsed;
}

function stringParam(params: Record<string, unknown>, name: string): string {
  const value = params[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Missing string parameter: ${name}`);
  }
  return value;
}

function boolParam(
  params: Record<string, unknown>,
  name: string,
  fallback = false,
): boolean {
  const value = params[name];
  if (typeof value === "boolean") return value;
  if (typeof value === "string")
    return /^(true|1|yes|on|enable|enabled)$/i.test(value);
  return fallback;
}

function sideParam(
  params: Record<string, unknown>,
  fallback: "left" | "right" | "both" = "both",
): "left" | "right" | "both" {
  const value = params.side ?? params.target;
  if (value === undefined) return fallback;
  if (value === "left" || value === "right" || value === "both") return value;
  throw new Error("side must be left, right, or both");
}

function connectionReadyModeParam(
  params: Record<string, unknown>,
): G1ConnectionReadyMode {
  const value = String(params.initMode ?? params.mode ?? params.variant ?? "")
    .trim()
    .toLowerCase();
  if (
    value === "official" ||
    value === "official-app" ||
    value === "even-demo-app" ||
    value === "same-init"
  )
    return "official";
  return "lens-specific";
}

function singleSideParam(
  params: Record<string, unknown>,
  fallback: "left" | "right" = "right",
): "left" | "right" {
  const side = sideParam(params, fallback);
  return side === "both" ? fallback : side;
}

function whitelistParam(
  params: Record<string, unknown>,
): string | Record<string, unknown> | unknown[] {
  const value =
    params.whitelist ?? params.allowlist ?? params.json ?? params.data;
  if (typeof value === "string" || Array.isArray(value)) return value;
  if (value && typeof value === "object")
    return value as Record<string, unknown>;
  throw new Error(
    "Missing whitelist payload: whitelist, allowlist, json, or data",
  );
}

function startAiSubcommand(value: unknown): G1SubCommand {
  if (typeof value === "number") return value as G1SubCommand;
  if (typeof value !== "string") return G1SubCommand.Start;
  const normalized = value
    .trim()
    .replace(/[\s-]+/g, "_")
    .toLowerCase();
  if (normalized === "exit" || normalized === "exit_dashboard")
    return G1SubCommand.Exit;
  if (normalized === "stop" || normalized === "clear") return G1SubCommand.Stop;
  return G1SubCommand.Start;
}

function bytesParam(params: Record<string, unknown>): Uint8Array {
  const value = params.data ?? params.bytes ?? params.hex ?? params.base64;
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value) && value.every((item) => Number.isInteger(item))) {
    return Uint8Array.from(value as number[]);
  }
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("Missing byte payload: data, bytes, hex, or base64");
  }
  const text = value.trim();
  if (
    /^(?:0x)?[0-9a-f]+$/i.test(text) &&
    text.replace(/^0x/i, "").length % 2 === 0
  ) {
    const hex = text.replace(/^0x/i, "");
    return Uint8Array.from(
      hex.match(/../g)?.map((byte) => Number.parseInt(byte, 16)) ?? [],
    );
  }
  if (typeof Buffer !== "undefined")
    return Uint8Array.from(Buffer.from(text, "base64"));
  if (typeof atob !== "undefined") {
    return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
  }
  throw new Error("Base64 payload decoding is not available");
}

function pixelBytesParam(params: Record<string, unknown>): Uint8Array {
  const value = params.pixels ?? params.pixelData ?? params.data;
  return bytesParam({ data: value });
}

function numberArrayParam(
  params: Record<string, unknown>,
  name: string,
): number[] {
  const value = params[name];
  if (Array.isArray(value) && value.every((item) => Number.isInteger(item))) {
    return value.map(Number);
  }
  return Array.from(bytesParam({ data: value }));
}

function dashboardLayoutParam(
  params: Record<string, unknown>,
): G1DashboardLayout {
  const value = String(params.layout ?? "full").toLowerCase();
  if (value === "full") return G1DashboardLayout.Full;
  if (value === "dual") return G1DashboardLayout.Dual;
  if (value === "minimal") return G1DashboardLayout.Minimal;
  throw new Error("layout must be full, dual, or minimal");
}

function temperatureUnitParam(value: unknown): G1TemperatureUnit | undefined {
  if (value === undefined) return undefined;
  const normalized = String(value).toLowerCase();
  if (normalized === "f" || normalized === "fahrenheit")
    return G1TemperatureUnit.Fahrenheit;
  if (normalized === "c" || normalized === "celsius")
    return G1TemperatureUnit.Celsius;
  throw new Error("temperatureUnit must be celsius or fahrenheit");
}

function timeFormatParam(value: unknown): G1TimeFormat | undefined {
  if (value === undefined) return undefined;
  const normalized = String(value).toLowerCase();
  if (normalized === "12" || normalized === "12h")
    return G1TimeFormat.TwelveHour;
  if (normalized === "24" || normalized === "24h")
    return G1TimeFormat.TwentyFourHour;
  throw new Error("timeFormat must be 12h or 24h");
}

export const smartglassesControlAction: Action = {
  name: "SMARTGLASSES_CONTROL",
  similes: [
    "EVEN_GLASSES_CONTROL",
    "SMARTGLASSES_SETTINGS",
    "SMARTGLASSES_NOTIFICATION",
    "SMARTGLASSES_NOTE",
  ],
  description:
    "Run Even Realities G1 control operations: clear/exit/start AI, connection-ready init including official same-init mode, RSVP display, heartbeat loop, raw packets, serial request, app whitelist/setup, silent mode, brightness, dashboard content, navigation, translation overlays, head-up angle, wear detection, notes, voice notes, notifications, and BMP images. Provide JSON with op and parameters.",
  descriptionCompressed:
    "smartglasses-control: display session, raw packets, settings, dashboard, navigation, translate, notes, notifications, BMP",
  contexts: ["smartglasses", "wearable", "operations"],
  validate: async (runtime: IAgentRuntime) =>
    Boolean(getSmartglassesService(runtime)),
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const service = getSmartglassesService(runtime);
    if (!service)
      return { success: false, text: "Smartglasses service not loaded" };

    const params = parseParams(message);
    const op = requireOp(params.op);
    if (!op) {
      return {
        success: false,
        text: "Provide a supported smartglasses op.",
        values: {
          supportedOps: SUPPORTED_OPS.join(","),
        },
      };
    }

    switch (op) {
      case "clear":
        await service.clearDisplay();
        break;
      case "exit_dashboard":
        await service.exitToDashboard();
        break;
      case "exit_function":
        await service.exitFunction();
        break;
      case "start_ai":
        await service.sendStartAi(
          startAiSubcommand(params.subcommand),
          params.param === undefined
            ? new Uint8Array()
            : bytesParam({ data: params.param }),
        );
        break;
      case "connection_ready":
        await service.sendConnectionReady(
          sideParam(params),
          connectionReadyModeParam(params),
        );
        break;
      case "page_up":
        await service.pageUp();
        break;
      case "page_down":
        await service.pageDown();
        break;
      case "rsvp_text":
        await service.displayRsvpText(stringParam(params, "text"), {
          wordsPerGroup:
            params.wordsPerGroup === undefined
              ? undefined
              : numberParam(params, "wordsPerGroup"),
          wpm:
            params.wpm === undefined ? undefined : numberParam(params, "wpm"),
          paddingChar:
            typeof params.paddingChar === "string"
              ? params.paddingChar
              : undefined,
          mode:
            params.mode === "text" || params.mode === "ai"
              ? params.mode
              : undefined,
          skipDelay: boolParam(params, "skipDelay", false),
        });
        break;
      case "heartbeat":
        await service.sendHeartbeat(
          params.seq === undefined ? undefined : numberParam(params, "seq"),
        );
        break;
      case "heartbeat_start":
        service.startHeartbeatLoop({
          intervalMs:
            params.intervalMs === undefined
              ? undefined
              : numberParam(params, "intervalMs"),
          immediate: boolParam(params, "immediate", true),
        });
        break;
      case "heartbeat_stop":
        service.stopHeartbeatLoop();
        break;
      case "raw":
        await service.sendRaw(bytesParam(params), sideParam(params));
        break;
      case "get_serial":
        await service.requestSerial(sideParam(params));
        break;
      case "app_whitelist":
        await service.sendAppWhitelist(
          whitelistParam(params),
          sideParam(params, "left"),
        );
        break;
      case "g1_setup":
        await service.sendG1Setup(
          whitelistParam(params),
          sideParam(params, "left"),
        );
        break;
      case "silent_mode":
        await service.setSilentMode(boolParam(params, "enabled", true));
        break;
      case "brightness":
        await service.setBrightness(
          numberParam(params, "level"),
          boolParam(params, "auto", false),
        );
        break;
      case "dashboard":
        await service.setDashboard(
          boolParam(params, "enabled", true),
          params.position === undefined ? 0 : numberParam(params, "position"),
        );
        break;
      case "dashboard_layout":
        await service.setDashboardLayout(dashboardLayoutParam(params));
        break;
      case "dashboard_calendar":
        await service.sendDashboardCalendarItem({
          name: stringParam(params, "name"),
          time: stringParam(params, "time"),
          location: stringParam(params, "location"),
        });
        break;
      case "dashboard_time_weather":
        await service.sendDashboardTimeWeather({
          seqId:
            params.seqId === undefined
              ? undefined
              : numberParam(params, "seqId"),
          timestampMs:
            params.timestampMs === undefined
              ? undefined
              : numberParam(params, "timestampMs"),
          timezoneOffsetSeconds:
            params.timezoneOffsetSeconds === undefined
              ? undefined
              : numberParam(params, "timezoneOffsetSeconds"),
          temperatureInCelsius: numberParam(params, "temperatureInCelsius"),
          weatherIcon:
            params.weatherIcon === undefined
              ? undefined
              : numberParam(params, "weatherIcon"),
          temperatureUnit: temperatureUnitParam(params.temperatureUnit),
          timeFormat: timeFormatParam(params.timeFormat),
        });
        break;
      case "headup_angle":
        await service.setHeadUpAngle(numberParam(params, "angle"));
        break;
      case "wear_detection":
        await service.setGlassesWearDetection(
          boolParam(params, "enabled", true),
        );
        break;
      case "navigation_start":
        await service.startNavigation();
        break;
      case "navigation_directions":
        await service.sendNavigationDirections({
          seqId:
            params.seqId === undefined
              ? undefined
              : numberParam(params, "seqId"),
          totalDuration: stringParam(params, "totalDuration"),
          totalDistance: stringParam(params, "totalDistance"),
          direction: stringParam(params, "direction"),
          distance: stringParam(params, "distance"),
          speed: stringParam(params, "speed"),
          directionTurn: numberParam(params, "directionTurn"),
          customX: Array.isArray(params.customX)
            ? (params.customX as number[])
            : undefined,
          customY:
            params.customY === undefined
              ? undefined
              : numberParam(params, "customY"),
        });
        break;
      case "navigation_primary_image":
        await service.sendNavigationPrimaryImage(
          numberArrayParam(params, "image"),
          numberArrayParam(params, "overlay"),
        );
        break;
      case "navigation_secondary_image":
        await service.sendNavigationSecondaryImage(
          numberArrayParam(params, "image"),
          numberArrayParam(params, "overlay"),
        );
        break;
      case "navigation_poller":
        await service.sendNavigationPoller();
        break;
      case "navigation_end":
        await service.endNavigation();
        break;
      case "translate_setup":
        await service.sendTranslateSetup();
        break;
      case "translate_start":
        await service.startTranslate();
        break;
      case "translate_languages":
        await service.setTranslateLanguages(
          numberParam(params, "fromLanguage"),
          numberParam(params, "toLanguage"),
        );
        break;
      case "translate_original":
        await service.sendTranslateText(
          "original",
          stringParam(params, "text"),
          params.syncId === undefined
            ? undefined
            : numberParam(params, "syncId"),
        );
        break;
      case "translate_translated":
        await service.sendTranslateText(
          "translated",
          stringParam(params, "text"),
          params.syncId === undefined
            ? undefined
            : numberParam(params, "syncId"),
        );
        break;
      case "note_add":
        await service.addOrUpdateNote(
          numberParam(params, "noteNumber"),
          stringParam(params, "title"),
          stringParam(params, "text"),
        );
        break;
      case "note_delete":
        await service.deleteNote(numberParam(params, "noteNumber"));
        break;
      case "voice_note_fetch":
        await service.requestVoiceNoteAudio(numberParam(params, "noteIndex"), {
          syncId:
            params.syncId === undefined
              ? undefined
              : numberParam(params, "syncId"),
          side: singleSideParam(params, "right"),
        });
        break;
      case "voice_note_delete":
        await service.deleteVoiceNoteAudio(numberParam(params, "noteIndex"), {
          syncId:
            params.syncId === undefined
              ? undefined
              : numberParam(params, "syncId"),
          side: singleSideParam(params, "right"),
        });
        break;
      case "notification":
        await service.sendNotification({
          msgId:
            params.msgId === undefined
              ? undefined
              : numberParam(params, "msgId"),
          type:
            params.type === undefined ? undefined : numberParam(params, "type"),
          appIdentifier: stringParam(params, "appIdentifier"),
          title: stringParam(params, "title"),
          subtitle:
            typeof params.subtitle === "string" ? params.subtitle : undefined,
          message: stringParam(params, "message"),
          timeS:
            params.timeS === undefined
              ? undefined
              : numberParam(params, "timeS"),
          date: typeof params.date === "string" ? params.date : undefined,
          displayName:
            typeof params.displayName === "string"
              ? params.displayName
              : undefined,
        });
        break;
      case "bmp_image":
        if (params.pixels !== undefined || params.pixelData !== undefined) {
          await service.sendMonochromeBmpImage(pixelBytesParam(params), {
            width:
              params.width === undefined
                ? undefined
                : numberParam(params, "width"),
            height:
              params.height === undefined
                ? undefined
                : numberParam(params, "height"),
            threshold:
              params.threshold === undefined
                ? undefined
                : numberParam(params, "threshold"),
          });
        } else {
          await service.sendBmpImage(bytesParam(params));
        }
        break;
    }

    const response = `Smartglasses ${op} command sent.`;
    await callback?.({ text: response });
    return { success: true, text: response, values: { op } };
  },
  examples: [],
};
