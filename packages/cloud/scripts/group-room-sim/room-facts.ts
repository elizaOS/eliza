/**
 * Hand-written per-room knowledge for the group-room simulation: the facts a
 * live Eliza should pick up from each room's human messages, and the
 * word-bounded matchers that give fact credit for mentioning them. This is the
 * only part of the spec that is not derived from the homepage module, so the
 * tool's tests fail if the homepage ever adds a room that has no entry here.
 *
 * Every matcher alternative is word-bounded or context-anchored so an
 * incidental substring ("monkeys", "cloud", "delegate", a lone digit) cannot
 * earn credit. Labels are the names that show up in results/<room>.md.
 */

import type { LandingDemoScenarioId } from "../../../homepage/src/lib/landing-demo";

export interface FactPattern {
  label: string;
  re: RegExp;
}

export const FACT_PATTERNS: Record<LandingDemoScenarioId, FactPattern[]> = {
  household: [
    {
      label: "tomatoes/parmesan already home",
      re: /\btomato(?:es)?\b|\bparmesan\b/i,
    },
    { label: "coffee low", re: /\bcoffee\b/i },
    { label: "oat milk", re: /\boat\s*milk\b/i },
    { label: "trash bags", re: /\btrash\s*bags?\b/i },
    { label: "recycling done", re: /\brecycl(?:e|ed|es|ing)\b/i },
    { label: "plants done", re: /\bplants?\b/i },
    { label: "dishwasher clean", re: /\bdishwasher\b/i },
    { label: "pasta dinner", re: /\bpasta\b/i },
    {
      label: "two jobs each / even split",
      re: /\b(?:two|2)\s+(?:jobs|each|chores|tasks)\b|\beven(?:ly)?\b[^.\n]{0,16}\bsplit\b|\bsplit\b[^.\n]{0,16}\beven(?:ly)?\b|\bfair\s+(?:split|share|shake)\b|\bthat'?s\s+even\b/i,
    },
  ],
  "co-parenting": [
    { label: "front pocket (inhaler)", re: /\bfront\s*pocket\b/i },
    { label: "inhaler", re: /\binhaler\b/i },
    { label: "blue bag/backpack", re: /\bblue\s*(?:bag|backpack)\b/i },
    {
      label: "permission slip / side pocket",
      re: /\bpermission\s*slip\b|\bside\s*pocket\b/i,
    },
    { label: "thursday 5 / 5:30 fallback", re: /\b5:30\b|\bthursday\b/i },
    { label: "saturday soccer", re: /\bsoccer\b/i },
    { label: "cleats", re: /\bcleats?\b/i },
    { label: "friday pickup/handoff", re: /\bfriday\b/i },
  ],
  friends: [
    { label: "vegetarian (Priya)", re: /\bvegetarian\b|\bveggie\b/i },
    { label: "peanut allergy (Jamie)", re: /\bpeanuts?\b/i },
    {
      label: "saturday after 7 / 7:30",
      re: /\b7:30\b|\bafter\s*7\b|\bsaturday\b/i,
    },
    { label: "quiet / not loud", re: /\bquiet\b|\bloud\b/i },
    { label: "noe valley", re: /\bnoe\b/i },
    {
      label: "patio / outdoor seating",
      re: /\bpatio\b|\boutdoor\b|\boutside\b/i,
    },
    {
      label: "cross-contact/allergy protocol",
      re: /\bcross[- ]contact\b|\bprotocols?\b|\ballerg(?:y|ies|ic|en|ens)\b/i,
    },
  ],
  trip: [
    { label: "arrivals meet ~10:20", re: /\b10:20\b|\barrivals?\b/i },
    { label: "red suitcase (Emi)", re: /\bred\s*suitcase\b/i },
    { label: "keys with Samira", re: /\bkeys?\b/i },
    {
      label: "check-in at 3",
      re: /\b3:00\b|\b3\s*pm\b|\b(?:at|til|till|until)\s+3\b|check[- ]?in\b[^.\n]{0,24}\b3\b/i,
    },
    {
      label: "bag drop",
      re: /\bbag\s*drop\b|\bluggage\b|\bstore\b[^.\n]{0,12}\bbags\b/i,
    },
    { label: "10:45 cutoff for Emi", re: /\b10:45\b/i },
    { label: "veggie food (Emi)", re: /\bveggie\b|\bvegetarian\b/i },
    { label: "rain / covered route", re: /\brain\b|\bcovered\b/i },
  ],
  community: [
    { label: "tuesday Rosa", re: /\btuesday\b/i },
    { label: "thursday Dev", re: /\bthursday\b/i },
    { label: "saturday user round", re: /\bsaturday\b/i },
    { label: "north bed", re: /\bnorth\s*bed\b/i },
    { label: "west bed", re: /\bwest\s*bed\b/i },
    { label: "shade cloth", re: /\bshade\b/i },
    {
      label: "seedlings extra water / heat",
      re: /\bseedlings?\b|\bheat\b|\bhot\b/i,
    },
    { label: "hose by the gate", re: /\bhose\b|\bgate\b/i },
    { label: "mulch", re: /\bmulch\b/i },
  ],
};

/** Plain-language facts behind the matchers, for humans reading a plan. */
export const ROOM_KEY_FACTS: Record<LandingDemoScenarioId, readonly string[]> =
  {
    household: [
      "Tomatoes and parmesan are already at home (so the grocery run stays small: only pasta and oat milk)",
      "Low/out items called out by humans: coffee, oat milk, trash bags",
      "Eli already took the recycling out (counts as a completed chore)",
      "Jules finished the plants and can cook the pasta",
      "Noor reports the dishwasher is clean (so Noor unloads it)",
      "Fair final split is two jobs each: You = coffee + laundry, Noor = dishwasher + 2-item run, Eli = recycling + trash bags, Jules = plants + pasta",
    ],
    "co-parenting": [
      "Ava's inhaler is in the front pocket of the blue backpack (Nina said 'her blue bag is packed' and later 'I have her inhaler btw')",
      "The permission slip is in the side pocket of the bag",
      "Pickup plan: Nina Thursday at 5 (user takes over if she isn't there by 5:30), user Friday, Nina does Saturday soccer at 9",
      "User brings the cleats Friday; Nina later decides cleats live in the car from now on",
      "Handoff attachment: Ava, Soccer, Friday 4:30 PM, Mission Rec Field",
    ],
    friends: [
      "Priya is vegetarian ('has to have veggie stuff for me lol')",
      "Jamie has a severe peanut allergy (room memory; needs a real cross-contact protocol)",
      "Time constraint: Saturday after 7 is the only overlap; 7:30 works for everyone",
      "Priya wants somewhere quiet; Leo wants not loud; Maya wants outside if it's nice",
      "Neighborhood: Maya votes Noe (Mission or Noe were the options)",
      "Pick: Cypress Table in Noe Valley, quiet patio, vegetarian mains, separate-tools peanut protocol with manager check",
    ],
    trip: [
      "Arrival times: Theo lands 9:40, Emi 10:15, three overlap at arrivals at 10:20; Samira is already there from the night before",
      "Samira has the apartment keys, but check-in is not until 3",
      "Emi has a huge red suitcase (how to spot her); if she's not out by 10:45, leave and she catches up",
      "Bags go to a staffed bag drop two blocks from the apartment; rain starts around 2, take the covered route",
      "Emi needs veggie food options; Theo gets burgers",
      "Itinerary: 10:20 meet at arrivals, drop bags, lunch, apartment at 3:00",
    ],
    community: [
      "Watering rotation: Rosa Tuesday, Dev Thursday, user Saturday",
      "Rosa also covers the north bed Tuesday; Tasha brings the other hose and leaves it by the gate",
      "Seedlings need the shade cloth Thursday; user drops it Wednesday",
      "West bed is super dry; user takes it on the Saturday round (both beds)",
      "Hot Sunday forecast means seedlings need extra water Saturday",
      "User always forgets Saturday stuff and asked for a reminder; Saturday reminder = heat-sensitive seedlings first, then west bed; Rosa checks mulch Tuesday",
    ],
  };
