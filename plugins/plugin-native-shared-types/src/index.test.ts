import { describe, expect, test } from "bun:test";
import type {
  EventCallback,
  ListenerEntry,
  SpeechRecognitionInstance,
  SpeechRecognitionResultEvent,
} from "./index";
import * as sharedTypes from "./index";

/**
 * Smoke test for the native shared-types contract package (issue #9943: it
 * shipped with zero tests). The package exposes only type contracts used across
 * the Capacitor/Electrobun native bridges, so this (a) proves the module is
 * importable at runtime and (b) constructs values against the exported generic
 * contracts and exercises them — a compile-time + runtime guard that the
 * contracts stay consumable and behave as documented.
 */
describe("@elizaos/native-plugin-shared-types", () => {
  test("the module is importable at runtime", () => {
    expect(typeof sharedTypes).toBe("object");
  });

  test("EventCallback delivers its typed payload", () => {
    const received: number[] = [];
    const onValue: EventCallback<number> = (value) => received.push(value);
    onValue(7);
    onValue(11);
    expect(received).toEqual([7, 11]);
  });

  test("ListenerEntry binds an event name to a typed callback", () => {
    let last = "";
    const entry: ListenerEntry<"speech", string> = {
      eventName: "speech",
      callback: (data) => {
        last = data;
      },
    };
    entry.callback("hello");
    expect(entry.eventName).toBe("speech");
    expect(last).toBe("hello");
  });

  test("SpeechRecognition contracts model the Web Speech surface used by the bridges", () => {
    const results: string[] = [];
    const recognition: Pick<
      SpeechRecognitionInstance,
      "continuous" | "interimResults" | "lang"
    > = {
      continuous: true,
      interimResults: false,
      lang: "en-US",
    };
    expect(recognition.continuous).toBe(true);
    expect(recognition.lang).toBe("en-US");

    const onResult = (event: SpeechRecognitionResultEvent) => {
      const first = event.results[event.resultIndex]?.[0]?.transcript;
      if (first) results.push(first);
    };
    const event: SpeechRecognitionResultEvent = {
      resultIndex: 0,
      results: {
        length: 1,
        0: {
          isFinal: true,
          0: { transcript: "open settings", confidence: 0.9 },
        },
      },
    };
    onResult(event);
    expect(results).toEqual(["open settings"]);
  });
});
