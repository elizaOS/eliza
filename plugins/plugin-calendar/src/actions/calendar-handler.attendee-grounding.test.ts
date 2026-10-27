/**
 * Planner-supplied addresses require explicit user address evidence; names pause.
 * Pure helper, no runtime; the real-PGlite handler case lives in
 * test/eliza-calendar.pglite.test.ts.
 */
import { describe, expect, it } from "vitest";
import {inferNativeCalendarCreate,registerCalendarActionHostAdapter,userAuthorizedCalendarAttendees } from "./calendar-handler";

describe("userAuthorizedCalendarAttendees", () => {
  it("rejects unverified proposals without silently omitting an attendee", () => {
    expect(() =>
      userAuthorizedCalendarAttendees(
        [{ email: "shawmakesmagic@example.invalid" }],
        ["add a barber appointment friday at 3pm to my calendar"],
      ),
    ).toThrow("email address is not verified");
    expect(() =>
      userAuthorizedCalendarAttendees(
        [{ email: "dana@acme.com", displayName: "Dana" }],
        ["add a dentist appointment friday at 3pm"],
      ),
    ).toThrow("email address is not verified");
  });

  it("keeps explicit addresses and pauses unverified named guests", () => {
    expect(
      userAuthorizedCalendarAttendees(
        [{ email: "bob@acme.com" }],
        ["invite bob@acme.com to the standup at 10"],
      ),
    ).toEqual([{ email: "bob@acme.com" }]);
    expect(() =>
      userAuthorizedCalendarAttendees(
        [{ email: "dana.k@acme.com", displayName: "Dana K" }],
        ["lunch with dana k on friday at noon"],
      ),
    ).toThrow("email address is not verified");
    expect(() =>
      userAuthorizedCalendarAttendees(
        [{ email: "bob@acme.com" }, { email: "eve@acme.com" }],
        ["set up a call with bob tomorrow at 9"],
      ),
    ).toThrow("email address is not verified");
    expect(
      userAuthorizedCalendarAttendees(
        [{ email: "bob@acme.com" }],
        ["book it for friday at 2", "bob@acme.com should be on it"],
      ),
    ).toEqual([{ email: "bob@acme.com" }]);
  });

  it("never keeps a reserved example-domain address, even when quoted", () => {
    expect(() =>
      userAuthorizedCalendarAttendees(
        [{ email: "someone@example.com" }],
        ["invite someone@example.com"],
      ),
    ).toThrow("email address is not verified");
  });

  it("passes undefined through and drops an empty list", () => {
    expect(userAuthorizedCalendarAttendees(undefined, ["x"])).toBeUndefined();
    expect(userAuthorizedCalendarAttendees([], ["x"])).toBeUndefined();
  });
});


describe("native Calendar strict creation clarification",()=>{
 const text="Put a 15-minute Calendar check event tomorrow at 3 pm.";
 const message={id:"native-current",entityId:"owner",roomId:"room",createdAt:Date.parse("2026-10-27T20:00:00Z"),content:{text}};
 const evidence=[{sourceId:"current:native-current",quote:text}];
 const extracted={requiresInput:false,grantId:null,calendarId:null,title:"Calendar check",description:null,location:null,startAt:"2026-10-28T15:00:00",endAt:"2026-10-28T15:15:00",timeZone:"America/Los_Angeles",recurrence:null,travelOriginAddress:null,durationMinutes:15,isShortPreparation:false,guestIntent:{state:"none",evidence,guests:[]},noteIntent:{state:"none",evidence,sourceNote:null}};
 async function run(parsed:Record<string,unknown>,failure?:Error){let calls=0;const runtime={agentId:"owner",getSetting:()=>null,getService:()=>null} as any;registerCalendarActionHostAdapter(runtime,{runJsonModel:async()=>{calls++;if(failure)throw failure;return {parsed};}} as any);const result=await inferNativeCalendarCreate({runtime,message:message as any,timeZone:"America/Los_Angeles",signal:new AbortController().signal});return {result,calls};}
 it("strict solo original produces review fields through the real native caller without saving",async()=>{const {result,calls}=await run(extracted);expect(calls).toBe(1);expect(result.fields?.title).toBe("Calendar check");expect(result.fields?.start).toBe("2026-10-28T22:00:00.000Z");expect(result.text).toContain("Review");});
 it.each([{}, {guestIntent:{state:"unresolved",evidence,guests:[]}}, {noteIntent:{state:"unresolved",evidence,sourceNote:null}}])("missing or unresolved intent returns clarification rather than throwing",async patch=>{const parsed=Object.keys(patch).length?{...extracted,...patch}:{...extracted,guestIntent:undefined};const {result,calls}=await run(parsed);expect(calls).toBe(1);expect(result.fields).toBeUndefined();expect(result.text).toContain("Clarify");});
 it("an unverified requested note returns the existing provenance clarification",async()=>{const {result}=await run({...extracted,noteIntent:{state:"requested",evidence,sourceNote:{agentId:"owner",noteId:"missing-note",contentHash:"unverified"}}});expect(result.fields).toBeUndefined();expect(result.text).toContain("Read the requested note again");});
 it("unrelated model failures remain failures",async()=>{await expect(run(extracted,new Error("synthetic transport failure"))).rejects.toThrow("synthetic transport failure");});
});
