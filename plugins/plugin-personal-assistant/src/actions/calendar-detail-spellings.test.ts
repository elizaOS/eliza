/**
 * The personal assistant registers its own Calendar family over the Calendar
 * plugin's `details` schemas, and it is the family a phone's planner is
 * offered. It is held to the same spelling contract as the standalone one.
 */
import { describeCalendarDetailSpellings } from "../../../plugin-calendar/test/calendar-detail-spellings-contract.ts";
import { personalAssistantPlugin } from "../plugin.ts";

describeCalendarDetailSpellings(personalAssistantPlugin.actions ?? []);
