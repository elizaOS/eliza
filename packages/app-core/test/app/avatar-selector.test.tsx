// @vitest-environment jsdom
import TestRenderer, { act } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

import { AvatarSelector } from "../../src/components/AvatarSelector";

vi.mock("@elizaos/app-core/state", () => ({
  useApp: () => ({ t: (k: string) => k }),
  getVrmPreviewUrl: vi.fn(() => "preview.png"),
  getVrmTitle: vi.fn(() => "Avatar"),
  VRM_COUNT: 4,
}));

describe("AvatarSelector", () => {
  it("suppresses onSelect clicks when loading is true", async () => {
    const onSelect = vi.fn();
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <AvatarSelector selected={1} onSelect={onSelect} loading={true} />,
      );
    });

    const buttons = renderer.root.findAllByType("button");
    const avatarButton = buttons[0];
    await act(async () => {
      avatarButton.props.onClick();
    });

    expect(onSelect).not.toHaveBeenCalled();
    expect(avatarButton.props.disabled).toBe(true);
  });

  it("calls onSelect when loading is false", async () => {
    const onSelect = vi.fn();
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <AvatarSelector selected={1} onSelect={onSelect} loading={false} />,
      );
    });

    const buttons = renderer.root.findAllByType("button");
    const avatarButton = buttons[1];
    await act(async () => {
      avatarButton.props.onClick();
    });

    expect(onSelect).toHaveBeenCalledWith(2);
    expect(avatarButton.props.disabled).toBe(false);
  });
});
