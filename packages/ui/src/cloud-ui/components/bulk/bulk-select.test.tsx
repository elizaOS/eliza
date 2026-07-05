// @vitest-environment jsdom

/**
 * Shared bulk-select kit (#13916): bar renders only while rows are selected,
 * wires clear/delete, and runBulkDelete partitions allSettled outcomes in
 * input order without throwing.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BulkSelectionBar, runBulkDelete } from "./bulk-select";

vi.mock("lucide-react", () => ({
  Trash2: () => <span aria-hidden="true" data-testid="trash-icon" />,
}));

const labels = {
  selected: "2 selected",
  clear: "Clear",
  deleteSelected: "Delete selected",
};

describe("BulkSelectionBar", () => {
  it("renders nothing at count 0", () => {
    const { container } = render(
      <BulkSelectionBar
        count={0}
        onClear={() => {}}
        onDelete={() => {}}
        labels={labels}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("wires clear and delete; delete honors disabled", () => {
    const onClear = vi.fn();
    const onDelete = vi.fn();
    render(
      <BulkSelectionBar
        count={2}
        onClear={onClear}
        onDelete={onDelete}
        deleteDisabled
        labels={labels}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(onClear).toHaveBeenCalledTimes(1);
    const del = screen.getByRole("button", { name: /Delete selected/ });
    expect(del).toHaveProperty("disabled", true);
  });
});

describe("runBulkDelete", () => {
  it("partitions fulfilled/rejected in input order and surfaces the first error", async () => {
    const boom = new Error("nope");
    const outcome = await runBulkDelete(["a", "b", "c"], (id) =>
      id === "b" ? Promise.reject(boom) : Promise.resolve(id),
    );
    expect(outcome.deleted).toEqual(["a", "c"]);
    expect(outcome.failed).toEqual(["b"]);
    expect(outcome.firstError).toBe(boom);
  });

  it("never throws even when every delete rejects", async () => {
    const outcome = await runBulkDelete([1, 2], () =>
      Promise.reject(new Error("all down")),
    );
    expect(outcome.deleted).toEqual([]);
    expect(outcome.failed).toEqual([1, 2]);
  });

  it("treats synchronous delete failures as rejected items", async () => {
    const outcome = await runBulkDelete(["a", "b"], (id) => {
      if (id === "b") throw new Error("sync down");
      return Promise.resolve(id);
    });
    expect(outcome.deleted).toEqual(["a"]);
    expect(outcome.failed).toEqual(["b"]);
    expect(outcome.firstError).toBeInstanceOf(Error);
  });
});
