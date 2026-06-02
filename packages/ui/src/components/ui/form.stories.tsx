import type { Meta, StoryObj } from "@storybook/react";
import { useForm } from "react-hook-form";
import { Button } from "./button";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "./form";
import { Input } from "./input";

// react-hook-form wrappers need a real form instance; a small demo form wires
// useForm() through Form (FormProvider) so the field/label/message compose.
function DemoForm({ withError = false }: { withError?: boolean }) {
  const form = useForm<{ username: string }>({
    defaultValues: { username: "" },
  });
  if (withError) {
    form.setError("username", { message: "Username is already taken." });
  }
  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(() => {})}
        className="flex w-80 flex-col gap-4"
      >
        <FormField
          control={form.control}
          name="username"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Username</FormLabel>
              <FormControl>
                <Input placeholder="chen" {...field} />
              </FormControl>
              <FormDescription>Your public display handle.</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        <Button type="submit" size="sm" className="self-start">
          Save
        </Button>
      </form>
    </Form>
  );
}

const meta = {
  title: "Primitives/Form",
  component: DemoForm,
  tags: ["autodocs"],
  parameters: { layout: "centered" },
} satisfies Meta<typeof DemoForm>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A field composed from FormField → FormItem/Label/Control/Description/Message. */
export const Default: Story = {};

/** The same field showing a validation message via FormMessage. */
export const WithError: Story = { args: { withError: true } };
