/**
 * Storybook states for the post-login PermissionPrimingModal, driven by injected
 * controller stubs: the per-permission soft-ask cards (microphone / location /
 * notifications), the requesting state, the two denied variants (retryable vs
 * settings-only), and the initial loading state.
 */
import type { PermissionId } from "@elizaos/shared/contracts/permissions";
import type { Meta, StoryObj } from "@storybook/react";
import { MockAppProvider } from "../../storybook/mock-providers";
import { PermissionPrimingModal } from "./PermissionPrimingModal";
import type {
  PermissionPrimingController,
  PrimingItem,
  PrimingItemStatus,
} from "./use-permission-priming";

const meta = {
  title: "Permissions/PermissionPrimingModal",
  component: PermissionPrimingModal,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <MockAppProvider>
        <Story />
      </MockAppProvider>
    ),
  ],
} satisfies Meta<typeof PermissionPrimingModal>;

export default meta;
type Story = StoryObj<typeof meta>;

function item(
  id: PermissionId,
  status: PrimingItemStatus,
  canRequest = false,
): PrimingItem {
  return { id, status, canRequest, requesting: false, resolved: false };
}

function controller(
  active: PrimingItem | null,
  overrides: Partial<PermissionPrimingController> = {},
): PermissionPrimingController {
  const items = active ? [active] : [];
  return {
    items,
    activeIndex: 0,
    active,
    currentStep: 1,
    totalSteps: items.length || 1,
    ready: true,
    done: active === null,
    request: async () => {},
    skip: () => {},
    openSettings: async () => {},
    recheck: async () => {},
    skipAll: () => {},
    ...overrides,
  };
}

const noop = () => {};

export const Microphone: Story = {
  args: {
    ids: ["microphone"],
    open: true,
    onComplete: noop,
    controllerOverride: controller(item("microphone", "not-determined", true), {
      currentStep: 1,
      totalSteps: 3,
    }),
  },
};

export const Location: Story = {
  args: {
    ids: ["location"],
    open: true,
    onComplete: noop,
    controllerOverride: controller(item("location", "not-determined", true), {
      currentStep: 3,
      totalSteps: 3,
    }),
  },
};

export const Notifications: Story = {
  args: {
    ids: ["notifications"],
    open: true,
    onComplete: noop,
    controllerOverride: controller(
      item("notifications", "not-determined", true),
      { currentStep: 2, totalSteps: 3 },
    ),
  },
};

export const Requesting: Story = {
  args: {
    ids: ["microphone"],
    open: true,
    onComplete: noop,
    controllerOverride: controller({
      id: "microphone",
      status: "not-determined",
      canRequest: true,
      requesting: true,
      resolved: false,
    }),
  },
};

export const DeniedRetryable: Story = {
  args: {
    ids: ["location"],
    open: true,
    onComplete: noop,
    controllerOverride: controller(item("location", "denied", true)),
  },
};

export const DeniedSettingsOnly: Story = {
  args: {
    ids: ["microphone"],
    open: true,
    onComplete: noop,
    controllerOverride: controller(item("microphone", "denied", false)),
  },
};

export const Loading: Story = {
  args: {
    ids: ["microphone"],
    open: true,
    onComplete: noop,
    controllerOverride: controller(null, { ready: false, done: false }),
  },
};
