/** Typed boundary between untrusted RFC 5545 feeds and calendar reconciliation. */

export type IcsParseState = "complete" | "partial" | "error";

export interface IcsAttendee {
  email: string | null;
  displayName: string | null;
  responseStatus: string | null;
  organizer: boolean;
  optional: boolean;
}

export interface IcsParsedEvent {
  uid: string;
  recurrenceId: string | null;
  sequence: number;
  revisionAt: string | null;
  title: string;
  description: string;
  location: string;
  status: string;
  startAt: string;
  endAt: string;
  isAllDay: boolean;
  timezone: string;
  url: string | null;
  organizer: IcsAttendee | null;
  attendees: IcsAttendee[];
  recurrence: string[];
  transparency: "opaque" | "transparent";
  classification: "public" | "private" | "confidential" | null;
  /**
   * Feed text is evidence, never authority. Downstream prompt construction
   * must retain this marker so descriptions cannot authorize mutations.
   */
  sourceTextTrusted: false;
}

export interface IcsParseIssue {
  code: string;
  message: string;
  eventIndex: number;
  uid: string | null;
}

export interface IcsParsedCalendar {
  name: string | null;
  timezone: string | null;
  method: string | null;
  productId: string | null;
  contentHash: string;
  state: IcsParseState;
  events: IcsParsedEvent[];
  issues: IcsParseIssue[];
}

export interface IcsFetchValidators {
  etag?: string;
  lastModified?: string;
}

export type IcsFetchResult =
  | {
      state: "not_modified";
      finalOrigin: string;
      etag: string | null;
      lastModified: string | null;
    }
  | {
      state: "fetched";
      finalOrigin: string;
      etag: string | null;
      lastModified: string | null;
      body: string;
      byteLength: number;
    };
