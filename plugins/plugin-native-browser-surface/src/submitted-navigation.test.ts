import { describe, expect, it } from "vitest";
import {
  SubmittedNavigation,
  type SubmittedNavigationVerdict,
} from "./submitted-navigation";

const tick = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
function fixture() {
  const calls: {
    address: string;
    resolve: (v: SubmittedNavigationVerdict) => void;
    reject: (error: Error) => void;
  }[] = [];
  const model = new SubmittedNavigation({
    check: (address) =>
      new Promise((resolve, reject) =>
        calls.push({ address, resolve, reject }),
      ),
  });
  return { model, calls };
}
describe("submitted address navigation", () => {
  it("fences stale checks across navigation, reload and close", async () => {
    const { model, calls } = fixture();
    model.open("https://one.test/");
    model.navigate("https://two.test/");
    calls[0].resolve({ status: "no-known-threat" });
    await tick();
    expect(model.snapshot().verdict).toBeNull();
    calls[1].resolve({ status: "blocked" });
    await tick();
    expect(model.snapshot().permitted).toBe(false);
    const revision = model.snapshot().revision;
    expect(model.allowOnce(revision)).toBe(true);
    model.reload();
    expect(model.snapshot().permitted).toBe(false);
    expect(model.allowOnce(revision)).toBe(false);
    model.close();
    calls[2].resolve({ status: "no-known-threat" });
    await tick();
    expect(model.snapshot().address).toBeNull();
    expect(model.snapshot().permitted).toBe(false);
  });
  it("branches submitted history and refuses invalid movement", () => {
    const { model } = fixture();
    model.open("a");
    model.navigate("b");
    model.navigate("c");
    model.move(1);
    model.navigate("d");
    expect(model.snapshot().history).toEqual(["a", "b", "d"]);
    expect(model.snapshot().index).toBe(2);
    for (const invalid of [-1, 3, NaN, 1.5])
      expect(model.move(invalid)).toBe(false);
    expect(model.snapshot().address).toBe("d");
    model.open("x");
    expect(model.snapshot().history).toEqual(["x"]);
  });
  it("requires a completed check and the current revision for explicit override", async () => {
    const { model, calls } = fixture();
    model.open("a");
    const revision = model.snapshot().revision;
    expect(model.allowOnce(revision)).toBe(false);
    calls[0].resolve({ status: "lookalike", suggested: "https://example.com" });
    await tick();
    expect(model.allowOnce(revision)).toBe(true);
    model.navigate("a");
    expect(model.snapshot().permitted).toBe(false);
    expect(model.allowOnce(revision)).toBe(false);
  });
  it("turns rejected and malformed verdicts into unavailable without permitting", async () => {
    const { model, calls } = fixture();
    model.open("a");
    calls[0].reject(new Error("offline"));
    await tick();
    expect(model.snapshot().verdict?.status).toBe("unavailable");
    expect(model.snapshot().permitted).toBe(false);
    model.reload();
    calls[1].resolve({
      status: "safe",
    } as unknown as SubmittedNavigationVerdict);
    await tick();
    expect(model.snapshot().verdict?.status).toBe("unavailable");
  });
  it("detaches verdicts and provides stable immutable snapshots with subscription cleanup", async () => {
    const { model, calls } = fixture();
    let notifications = 0;
    const off = model.subscribe(() => notifications++);
    model.open("a");
    const input: { status: "no-known-threat"; source: string } = {
      status: "no-known-threat",
      source: "list",
    };
    calls[0].resolve(input);
    await tick();
    const snapshot = model.snapshot();
    input.source = "changed";
    expect(snapshot.verdict?.source).toBe("list");
    expect(snapshot.permitted).toBe(true);
    expect(model.snapshot()).toBe(snapshot);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.history)).toBe(true);
    expect(Object.isFrozen(snapshot.verdict)).toBe(true);
    off();
    model.close();
    expect(notifications).toBe(2);
  });
  it("does not start a check invalidated synchronously by a subscriber", () => {
    const { model, calls } = fixture();
    model.subscribe(() => {
      if (model.snapshot().address) model.close();
    });
    model.open("a");
    expect(calls).toHaveLength(0);
  });
});
