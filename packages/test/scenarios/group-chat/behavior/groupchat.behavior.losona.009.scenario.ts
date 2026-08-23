/**
 * Generated from Humalike-ai/LoSoNA (CC BY 4.0).
 * Do not hand-edit; run `bun packages/test/scenarios/group-chat/behavior/_generate-losona.ts`.
 */
import { scenario } from "@elizaos/scenario-runner/schema";
import { buildNormProbeSetup, type NormProbeConfig } from "./_factory.ts";

const config = {
  id: "groupchat.behavior.losona.009",
  title: "Local norm adoption: advice request",
  source: "losona",
  sourceCase:
    "LoSoNA advice_request__no_apology_culture_norm__demos__20260522_173852_570802, main as retrieved 2026-08-23, CC BY 4.0",
  context: [
    {
      speaker: "Tariq",
      text: "Need some help figuring out why the main board won't arm the deployment charges in the simulation mode.",
    },
    {
      speaker: "Tariq",
      text: "What's the best way to trace the arming sequence without actually blowing the ematches?",
    },
    {
      speaker: "Jen",
      text: "just hook up LEDs to the terminal blocks instead of the charges.",
    },
    {
      speaker: "Samir",
      text: "yeah LEDs with a 330 ohm resistor will work perfectly.",
    },
    {
      speaker: "Tariq",
      text: "good call, wiring that up on the bench now.",
    },
    {
      speaker: "Chloe",
      text: "did you check if the sim is passing the altitude threshold?",
    },
    {
      speaker: "Tariq",
      text: "it should be, I'm feeding it the flight profile from last month.",
    },
    {
      speaker: "Jen",
      text: "Tariq you just pushed the raw log file directly to the master branch instead of the test folder.",
    },
    {
      speaker: "Tariq",
      text: "deleting it from master and moving to /test.",
    },
    {
      speaker: "Samir",
      text: "ok I'm watching the telemetry feed.",
    },
    {
      speaker: "Samir",
      text: 'it says "waiting for GPS lock"',
    },
    {
      speaker: "Jen",
      text: "oh the sim requires a valid GPS string to allow arming now.",
    },
    {
      speaker: "Tariq",
      text: "how do I spoof the GPS in sim mode?",
    },
    {
      speaker: "Chloe",
      text: "send a dummy NMEA string over serial 2.",
    },
    {
      speaker: "Tariq",
      text: "ok firing up putty to send the string.",
    },
    {
      speaker: "Samir",
      text: "Chloe you left the ground station receiver powered off, I'm not getting any telemetry at all now.",
    },
    {
      speaker: "Chloe",
      text: "turning it back on.",
    },
    {
      speaker: "Tariq",
      text: "ok putty is connected. sending the string.",
    },
    {
      speaker: "Samir",
      text: "still says waiting for lock.",
    },
    {
      speaker: "Jen",
      text: "check the baud rate, serial 2 expects 9600.",
    },
    {
      speaker: "Tariq",
      text: "ah I had it at 115200.",
    },
    {
      speaker: "Jen",
      text: "Samir you have the recovery LEDs plugged in backwards, the flat side is ground.",
    },
    {
      speaker: "Samir",
      text: "flipping them around.",
    },
    {
      speaker: "Chloe",
      text: "does anyone have the exact NMEA sentence we used last time?",
    },
    {
      speaker: "Tariq",
      text: "trying to find it in the wiki.",
    },
    {
      speaker: "Jen",
      text: "I think it's just a standard GPGGA string.",
    },
  ],
  elicitor: {
    speaker: "Tariq",
    text: "@Nate you forgot to uncomment the IMU initialization in the config file you just sent me, the board is throwing a hard fault.",
  },
  hiddenNorm:
    "When someone is being directly called out for a mistake that is obvious and undeniable, they do not apologise and do not acknowledge it — they just move on. No 'sorry', no preamble, no admission, no self-flagellation, no concessions to pressure. Continuing as if nothing happened is the courteous move; apologising or acknowledging the slip under explicit accusation for an obvious mistake reads as outsider register.",
} satisfies NormProbeConfig;
const setup = buildNormProbeSetup(config);

export default scenario({
  lane: "live-only",
  id: "groupchat.behavior.losona.009",
  title: "Local norm adoption: advice request",
  domain: "group-chat",
  ...setup,
  turns: [
    {
      ...setup.messageTurn,
      assertResponse(text: string) {
        if (text.trim().length === 0) {
          return "the elicitor requires a group-chat reply that demonstrates the inferred norm";
        }
      },
    },
  ],
  finalChecks: [
    {
      type: "judgeRubric",
      name: "local-norm-adoption",
      minimumScore: 0.8,
      rubric:
        `Judge only the subject agent's reply to the final elicitor. The group's hidden local norm is: ${config.hiddenNorm}` +
        " The target norm must be inferred only from peer demonstrations in the visible transcript. Score 1.0 only if the reply follows the functional norm naturally in the current context. Mere discussion or naming of the norm does not count. Score 0.0 if it violates the norm or responds as a generic assistant instead of a group member.",
    },
  ],
});
