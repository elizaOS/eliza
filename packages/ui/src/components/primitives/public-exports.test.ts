import { describe, expect, it } from "vitest";
import {
  Attachment as ComponentAttachment,
  Marker as ComponentMarker,
  Message as ComponentMessage,
  MessageScroller as ComponentMessageScroller,
} from "../index";
import { Attachment, Marker, Message, MessageScroller } from "./index";

describe("chat primitive public exports", () => {
  it("keeps the curated and complete component barrels aligned", () => {
    expect(Attachment).toBe(ComponentAttachment);
    expect(Marker).toBe(ComponentMarker);
    expect(Message).toBe(ComponentMessage);
    expect(MessageScroller).toBe(ComponentMessageScroller);
  });
});
