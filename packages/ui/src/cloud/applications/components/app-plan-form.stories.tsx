/** Shows explicit USD plan terms; submission is handled by the owning catalog command boundary. */
import type { Meta, StoryObj } from "@storybook/react";
import { AppPlanForm } from "./app-plan-form";

const meta = {
  title: "Cloud/Apps/Plan terms",
  component: AppPlanForm,
  args: {
    merchantId: "merchant-test",
    clientRegistrationId: "client-test",
    disabled: false,
    onSubmit: () => undefined,
  },
} satisfies Meta<typeof AppPlanForm>;
export default meta;
export const NewPlan: StoryObj<typeof meta> = {};
