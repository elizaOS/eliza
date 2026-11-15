/** Renderer-neutral Maps chat projection and its share-answer gate. */
import { describe, expect, it } from "vitest";
import {
  createMapsChatAnswers,
  formatMapsDistance,
  formatMapsDuration,
  MAPS_CHAT_DRAFT_NOTICE,
  type MapsChatAnswerPort,
  type MapsChatMessageInput,
  projectMapsChatText,
} from "../message-maps-text";

const place = {
  name: "Ferry Building",
  latitude: 37.7955,
  longitude: -122.3937,
  provider: "eliza-cloud",
  providerPlaceId: "osm:n1",
  formattedAddress: "1 Ferry Building, San Francisco",
  categories: [],
};
const attribution = "© OpenStreetMap contributors";
// The wire shapes plugin-maps `appendMapsCard` and core `appendInteractionBlock` emit.
const card = (text: string, body: unknown) =>
  `${text}\n\n[MAPSCARD]\n${JSON.stringify(body)}\n[/MAPSCARD]`;
const shareOptions = [
  {
    value: "Yes, share the location of Ferry Building (confirmed).",
    label: "Share location",
  },
  { value: "No, do not share my location.", label: "Don't share" },
];
const share = (prompt = "Share the location of Ferry Building?") =>
  `${prompt}\n\n[CHOICE:maps-share id=maps-share-m1]\n${shareOptions
    .map((option) => `${option.value}=${option.label}`)
    .join("\n")}\n[/CHOICE]`;

describe("projectMapsChatText", () => {
  it("turns place, search and route cards into text cards with attribution", () => {
    expect(
      projectMapsChatText(card("Found it.", { kind: "place", place, attribution })),
    ).toEqual({
      displayText: "Found it.",
      cards: [
        {
          kind: "place",
          title: "Ferry Building",
          lines: ["1 Ferry Building, San Francisco"],
          attribution,
        },
      ],
      choice: null,
    });
    const search = projectMapsChatText(
      card("Two matches.", {
        kind: "places",
        query: "ferry",
        places: [
          place,
          {
            ...place,
            name: "Pier 1",
            formattedAddress: undefined,
            providerPlaceId: "osm:n2",
          },
        ],
        nextCursor: null,
        attribution,
      }),
    );
    expect(search.cards[0]).toEqual({
      kind: "places",
      title: "Places for “ferry”",
      lines: ["Ferry Building, 1 Ferry Building, San Francisco", "Pier 1"],
      attribution,
    });
    const route = projectMapsChatText(
      card("Here is the route.", {
        kind: "route",
        origin: { ...place, name: "Home", providerPlaceId: "osm:n0" },
        destination: place,
        travelMode: "walk",
        distanceMeters: 1530,
        durationSeconds: 1260,
        warnings: ["Steep section"],
        attribution,
      }),
    );
    expect(route).toEqual({
      displayText: "Here is the route.",
      cards: [
        {
          kind: "route",
          title: "Route to Ferry Building",
          lines: ["From Home", "Walking · 1.5 km · 21 min", "Steep section"],
          attribution,
        },
      ],
      choice: null,
    });
  });

  it("shows a handoff link as text and lets the host word the locate card", () => {
    const handoff = projectMapsChatText(
      card("Shared.", {
        kind: "handoff",
        handoffKind: "share",
        place,
        geoUri: "geo:37.7955,-122.3937",
        appleMapsUri: "https://maps.apple.com/?ll=37.7955,-122.3937",
        webUri: "https://www.openstreetmap.org/?mlat=37.7955&mlon=-122.3937",
      }),
    );
    expect(handoff.cards[0]).toEqual({
      kind: "handoff",
      title: "Location link for Ferry Building",
      lines: [
        "1 Ferry Building, San Francisco",
        "https://www.openstreetmap.org/?mlat=37.7955&mlon=-122.3937",
      ],
      attribution: "",
    });
    const locate = card("Where are you starting from?", {
      kind: "locate",
      intent: "route-origin",
      prompt: "Where are you starting from?",
    });
    expect(projectMapsChatText(locate).cards[0].lines).toEqual([
      "Reply with a place or address.",
    ]);
    expect(
      projectMapsChatText(locate, { locateLines: ["Name a starting place."] })
        .cards[0],
    ).toEqual({
      kind: "locate",
      title: "Location needed",
      lines: ["Name a starting place."],
      attribution: "",
    });
  });

  it("keeps the share question as prose and offers its two exact answers", () => {
    expect(projectMapsChatText(share())).toEqual({
      displayText: "Share the location of Ferry Building?",
      cards: [],
      choice: { id: "maps-share-m1", options: shareOptions },
    });
    // A place name may contain "="; the label never does.
    const named = projectMapsChatText(
      "Share?\n\n[CHOICE:maps-share id=maps-share-m2]\nYes, share the location of A=B (confirmed).=Share location\nNo.=Don't share\n[/CHOICE]",
    );
    expect(named.choice?.options[0]).toEqual({
      value: "Yes, share the location of A=B (confirmed).",
      label: "Share location",
    });
  });

  it("leaves ordinary, malformed, out-of-policy and foreign markup literal", () => {
    const ordinary = "  An indented reply.\n\n\tSecond paragraph.  \n";
    expect(projectMapsChatText(ordinary)).toEqual({
      displayText: ordinary,
      cards: [],
      choice: null,
    });
    for (const text of [
      "[MAPSCARD]\n{not json}\n[/MAPSCARD]",
      `[MAPSCARD]\n${JSON.stringify({ kind: "place", place: { ...place, latitude: 200 }, attribution })}\n[/MAPSCARD]`,
      `[MAPSCARD]\n${JSON.stringify({ kind: "handoff", handoffKind: "share", place, geoUri: "geo:1,2", appleMapsUri: "https://maps.apple.com/", webUri: "https://evil.example/" })}\n[/MAPSCARD]`,
      "[CHOICE:maps-share id=maps-share-x]\nonly-one=Option\n[/CHOICE]",
      "[CHOICE:maps-share id=maps-share-x]\nno separator\nb=B\n[/CHOICE]",
      "[CHOICE:other-scope id=maps-share-x]\na=A\nb=B\n[/CHOICE]",
      `[CHOICE:maps-share id=maps-share-x]\na=${"L".repeat(81)}\nb=B\n[/CHOICE]`,
    ]) {
      expect(projectMapsChatText(text), text).toEqual({
        displayText: text,
        cards: [],
        choice: null,
      });
    }
  });

  it("formats distance and duration like the inline widgets", () => {
    expect(formatMapsDistance(640.4)).toBe("640 m");
    expect(formatMapsDistance(123_456)).toBe("123 km");
    expect(formatMapsDuration(10)).toBe("1 min");
    expect(formatMapsDuration(7200)).toBe("2 h");
    expect(formatMapsDuration(5520)).toBe("1 h 32 min");
  });
});

function surface(messages: MapsChatMessageInput[]) {
  const state = {
    canAnswer: true,
    draft: "",
    sent: [] as string[],
    notices: [] as string[],
    refreshes: 0,
    fail: null as Error | null,
  };
  const port: MapsChatAnswerPort = {
    async send(text) {
      if (state.fail) throw state.fail;
      state.sent.push(text);
    },
    canAnswer: () => state.canAnswer,
    draft: () => state.draft,
    refresh: () => {
      state.refreshes += 1;
    },
    notify: (message) => {
      state.notices.push(message);
    },
  };
  return { state, answers: createMapsChatAnswers(port), messages };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const placeText = card("Found it.", { kind: "place", place, attribution });

describe("createMapsChatAnswers", () => {
  it("projects agent replies only and sends nothing while rendering", () => {
    const { state, answers, messages } = surface([
      { id: "u0", isAgent: false, text: placeText },
      { id: "a1", isAgent: true, text: placeText },
      { id: "a2", isAgent: true, text: "Plain reply." },
      { id: "a3", isAgent: true, text: share() },
    ]);
    for (let n = 0; n < 20; n += 1) answers.project(messages);
    const views = answers.project(messages);
    expect(state.sent).toEqual([]);
    expect(views[0]).toBeNull();
    expect(views[1]?.displayText).toBe("Found it.");
    expect(views[2]).toBeNull();
    expect(views[3]?.choice?.id).toBe("a3:maps-share-m1");
    expect(views[3]?.choice?.options.map((option) => option.label)).toEqual([
      "Share location",
      "Don't share",
    ]);
  });

  it("sends one exact answer once and then offers no second answer", async () => {
    const { state, answers, messages } = surface([
      { id: "a1", isAgent: true, text: share() },
    ]);
    const choice = answers.project(messages)[0]?.choice;
    choice?.options[0].choose();
    choice?.options[1].choose();
    await tick();
    expect(state.sent).toEqual([
      "Yes, share the location of Ferry Building (confirmed).",
    ]);
    expect(answers.answered("a1:maps-share-m1")).toBe(true);
    expect(answers.project(messages)[0]?.choice).toBeNull();
    expect(answers.project(messages)[0]?.displayText).toBe(
      "Share the location of Ferry Building?",
    );
  });

  it("never answers an older question, over a draft, or while it cannot send", async () => {
    const older = surface([
      { id: "a1", isAgent: true, text: share() },
      { id: "u2", isAgent: false, text: "Never mind" },
    ]);
    expect(older.answers.project(older.messages)[0]?.choice).toBeNull();

    const draft = surface([{ id: "a1", isAgent: true, text: share() }]);
    draft.state.draft = "Keep my words";
    draft.answers.project(draft.messages)[0]?.choice?.options[0].choose();
    await tick();
    expect(draft.state.sent).toEqual([]);
    expect(draft.state.notices).toEqual([MAPS_CHAT_DRAFT_NOTICE]);
    expect(draft.answers.answered("a1:maps-share-m1")).toBe(false);

    const busy = surface([{ id: "a1", isAgent: true, text: share() }]);
    busy.state.canAnswer = false;
    busy.answers.project(busy.messages)[0]?.choice?.options[1].choose();
    await tick();
    expect(busy.state.sent).toEqual([]);
    expect(busy.state.notices).toEqual([]);
  });

  it("reopens the question when sending fails", async () => {
    const { state, answers, messages } = surface([
      { id: "a1", isAgent: true, text: share() },
    ]);
    state.fail = new Error("Offline");
    answers.project(messages)[0]?.choice?.options[1].choose();
    await tick();
    expect(state.notices).toEqual(["Offline"]);
    expect(answers.answered("a1:maps-share-m1")).toBe(false);
    state.fail = null;
    answers.project(messages)[0]?.choice?.options[1].choose();
    await tick();
    expect(state.sent).toEqual(["No, do not share my location."]);
  });
});
