/** Exercises viewport feedback ownership and dismissal under a collapsed chat container in jsdom. */
// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { ActionNoticeToast } from "./ActionNoticeToast";

afterEach(cleanup);
it("keeps feedback outside a hidden chat ancestor and removes it on dismissal", () => {
  const { rerender } = render(
    <div hidden>
      <ActionNoticeToast
        actionNotice={{ tone: "error", text: "Try reconnecting" }}
      />
    </div>,
  );
  const feedback = screen.getByRole("status");
  expect(feedback.parentElement).toBe(document.body);
  expect(feedback.textContent).toBe("Try reconnecting");
  rerender(
    <div hidden>
      <ActionNoticeToast actionNotice={null} />
    </div>,
  );
  expect(screen.queryByRole("status")).toBeNull();
});
