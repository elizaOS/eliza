import { describe, expect, it } from "vitest";
import {
  continuesFinishedWork,
  finishedWorkRelation,
} from "../actions/tasks.js";

const COUNT = "count the .ts files in apps/ and tell me the number";

describe("continuesFinishedWork", () => {
  it("a new deliverable with no overlap is a fresh build", () => {
    expect(
      continuesFinishedWork(
        "write me a python script that prints a random prime under 1000 and run it",
        COUNT,
      ),
    ).toBe(false);
    expect(continuesFinishedWork("build me a dice roller page", COUNT)).toBe(
      false,
    );
  });

  it("follow-ups and related asks continue the finished lane", () => {
    expect(continuesFinishedWork("run it again", COUNT)).toBe(true);
    expect(continuesFinishedWork("add a footer to it", COUNT)).toBe(true);
    expect(
      continuesFinishedWork(
        "make a second script that counts .tsx files in apps/",
        COUNT,
      ),
    ).toBe(true);
    expect(
      continuesFinishedWork(
        "write me another page like the dice roller but for coins",
        "build me a dice roller page",
      ),
    ).toBe(true);
  });

  it("distinguishes a follow-up from a related new deliverable", () => {
    expect(finishedWorkRelation("run it again", COUNT)).toBe("follow_up");
    expect(
      finishedWorkRelation(
        "make a second script that counts .tsx files in apps/",
        COUNT,
      ),
    ).toBe("related");
    expect(
      finishedWorkRelation(
        "write me a python script that prints a random prime",
        COUNT,
      ),
    ).toBe("fresh");
  });
});
