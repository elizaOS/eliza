/** Catalogs every provider canary backed by an installable production path. */
import bluebubbles from "./provider.bluebubbles-imessage.confirmed-send.scenario.ts";
import discord from "./provider.discord.confirmed-send.scenario.ts";
import duffel from "./provider.duffel-travel.booking.scenario.ts";
import gmail from "./provider.gmail.confirmed-send.scenario.ts";
import googleCalendar from "./provider.google-calendar.create.scenario.ts";
import googleSheets from "./provider.google-sheets.create.scenario.ts";
import signal from "./provider.signal.confirmed-send.scenario.ts";
import slack from "./provider.slack.confirmed-send.scenario.ts";
import telegram from "./provider.telegram.confirmed-send.scenario.ts";
import twilioSms from "./provider.twilio-sms.confirmed-send.scenario.ts";
import twilioVoice from "./provider.twilio-voice.confirmed-call.scenario.ts";
import whatsapp from "./provider.whatsapp.confirmed-send.scenario.ts";
import xDm from "./provider.x-dm.confirmed-send.scenario.ts";

export const PROVIDER_CANARY_SCENARIOS = [
  bluebubbles,
  discord,
  duffel,
  gmail,
  googleCalendar,
  googleSheets,
  signal,
  slack,
  telegram,
  twilioSms,
  twilioVoice,
  whatsapp,
  xDm,
] as const;
