import { describe, expect, it } from "vitest";
import { looksLikeExplicitUndatedOwnerTodoRequest } from "../../lifeops/todos/direct-routing.ts";
import { textStatesExplicitUndatedTodo } from "./undated-todo-intent.ts";

const VI_UNDATED = "thêm việc cần làm gọi mẹ, không có ngày đến hạn";

describe("Vietnamese words ending in a non-ASCII letter", () => {
  it.each([
    ["thứ tư (Wednesday)", `${VI_UNDATED}, à làm vào thứ tư`],
    ["lúc 3 giờ (at 3 o'clock)", `${VI_UNDATED}, nhắc lúc 3 giờ`],
    ["sau 2 giờ (in 2 hours)", `${VI_UNDATED}, sau 2 giờ`],
  ])("treats a later %s as a schedule, not as undated", (_label, text) => {
    expect(textStatesExplicitUndatedTodo(text)).toBe(false);
  });

  it("keeps the ASCII-ending weekday and a plain undated request unchanged", () => {
    expect(
      textStatesExplicitUndatedTodo(`${VI_UNDATED}, à làm vào thứ hai`),
    ).toBe(false);
    expect(textStatesExplicitUndatedTodo(VI_UNDATED)).toBe(true);
  });

  it("routes a 'nhiệm vụ' request like a 'việc cần làm' request", () => {
    expect(
      looksLikeExplicitUndatedOwnerTodoRequest(
        "tạo nhiệm vụ gọi mẹ, không có ngày đến hạn",
      ),
    ).toBe(true);
    expect(
      looksLikeExplicitUndatedOwnerTodoRequest(
        "tạo việc cần làm gọi mẹ, không có ngày đến hạn",
      ),
    ).toBe(true);
  });
});
