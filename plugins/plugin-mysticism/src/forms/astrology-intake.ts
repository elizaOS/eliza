/** Conversational intake form for astrology natal chart readings. */

import type { FormDefinition } from "../types";

export const astrologyIntakeForm: FormDefinition = {
  id: "astrology_intake",
  name: "Astrology Reading Intake",
  description:
    "To create your natal chart, I'll need your exact birth details. " +
    "The more precise the information, the more accurate your reading will be.",
  controls: [
    {
      key: "question",
      type: "text",
      label: "Your Focus Area",
      required: true,
      ask:
        "Before we dive into your chart, what area of your life are you most " +
        "curious about? This helps me focus the interpretation on what matters " +
        "most to you right now.",
      description: "The querent's area of interest or question for the reading",
      hint: ["question", "focus", "curious", "about", "guidance", "wondering"],
      example: "I want to understand my relationship patterns better",
      minLength: 5,
      maxLength: 500,
    },
    {
      key: "birth_date",
      type: "date",
      label: "Birth Date",
      required: true,
      ask:
        "What is your date of birth? You can say it naturally, like " +
        "'March 15, 1992' or '1992-03-15'.",
      description: "The querent's date of birth (YYYY-MM-DD)",
      hint: ["born", "birthday", "birth date", "date of birth", "dob"],
      example: "March 15, 1992",
    },
    {
      key: "birth_time",
      type: "text",
      label: "Birth Time",
      required: true,
      ask:
        "What time were you born? This is crucial for calculating your " +
        "Rising sign and house placements. If you know the exact time, " +
        "great — even an approximate time helps. Check your birth certificate " +
        "if you can.",
      description: "The querent's time of birth (HH:MM in 24h or with AM/PM)",
      pattern: "^([01]?\\d|2[0-3]):[0-5]\\d(\\s*[AaPp][Mm])?$",
      hint: ["time", "born at", "birth time", "o'clock", "am", "pm"],
      example: "2:30 PM",
    },
    {
      key: "birth_place",
      type: "text",
      label: "Birth Place",
      required: true,
      ask:
        "Where were you born? City and country is ideal — for example, " +
        "'Austin, Texas, USA' or 'London, UK'. This is needed to calculate " +
        "the exact positions of the planets at your birth location.",
      description: "The querent's place of birth (city, state/country)",
      hint: ["born in", "birth place", "birthplace", "city", "where", "location"],
      example: "Austin, Texas, USA",
      minLength: 3,
      maxLength: 200,
    },
    {
      key: "birth_timezone",
      type: "text",
      label: "Birth Timezone",
      ask:
        "Do you know what timezone your birth time is in? For example, " +
        "'Eastern Time', 'UTC+5:30', or 'PST'. If you're not sure, " +
        "I can figure it out from your birth place — just say 'skip'.",
      description: "The timezone of the birth time, if known",
      hint: ["timezone", "time zone", "utc", "gmt", "est", "pst", "cst", "mst"],
      example: "Eastern Time (ET)",
    },
  ],
  onSubmit: "handle_astrology_intake",
  onCancel: "handle_reading_cancel",
  ttl: { minDays: 7, maxDays: 30 },
  nudgeAfterMinutes: 48,
  nudgeMessage:
    "I noticed you started setting up an astrology reading but we still " +
    "need some birth details. Would you like to continue? Your information " +
    "so far is saved.",
};

export default astrologyIntakeForm;
