import type * as LabelPrimitive from "@radix-ui/react-label";
import { Slot } from "@radix-ui/react-slot";
import * as React from "react";
import {
  type ControllerProps,
  type FieldPath,
  type FieldValues,
} from "react-hook-form";

/**
 * Form provider component that wraps react-hook-form's FormProvider.
 * Provides form context to all child form components.
 */
declare const Form: <
  TFieldValues extends FieldValues,
  TContext = any,
  TTransformedValues = TFieldValues,
>(
  props: import("react-hook-form").FormProviderProps<
    TFieldValues,
    TContext,
    TTransformedValues
  >,
) => React.JSX.Element;
/**
 * Form field component that wraps react-hook-form's Controller.
 * Provides field context and manages form field state.
 *
 * @param props - Controller props from react-hook-form
 */
declare const FormField: <
  TFieldValues extends FieldValues = FieldValues,
  TName extends FieldPath<TFieldValues> = FieldPath<TFieldValues>,
>({
  ...props
}: ControllerProps<
  TFieldValues,
  TName
>) => import("react/jsx-runtime").JSX.Element;
/**
 * Hook to access form field state and IDs.
 * Must be used within a FormField component.
 *
 * @returns Field state including id, name, formItemId, formDescriptionId, formMessageId, and validation state
 * @throws Error if used outside of FormField context
 */
declare const useFormField: () => {
  invalid: boolean;
  isDirty: boolean;
  isTouched: boolean;
  isValidating: boolean;
  error?: import("react-hook-form").FieldError;
  id: string;
  name: string;
  formItemId: string;
  formDescriptionId: string;
  formMessageId: string;
};
/**
 * Form item container that provides unique ID context for form elements.
 */
declare function FormItem({
  className,
  ...props
}: React.ComponentProps<"div">): import("react/jsx-runtime").JSX.Element;
/**
 * Form label component with error state styling.
 * Automatically associates with form field via useFormField hook.
 */
declare function FormLabel({
  className,
  ...props
}: React.ComponentProps<
  typeof LabelPrimitive.Root
>): import("react/jsx-runtime").JSX.Element;
/**
 * Form control wrapper that applies accessibility attributes.
 * Uses Radix Slot to merge props with the form input element.
 */
declare function FormControl({
  ...props
}: React.ComponentProps<typeof Slot>): import("react/jsx-runtime").JSX.Element;
/**
 * Form description text displayed below the form control.
 * Automatically associated with form field for accessibility.
 */
declare function FormDescription({
  className,
  ...props
}: React.ComponentProps<"p">): import("react/jsx-runtime").JSX.Element;
/**
 * Form error message component.
 * Displays validation errors from react-hook-form or custom children.
 * Returns null if no error message is available.
 */
declare function FormMessage({
  className,
  ...props
}: React.ComponentProps<"p">): import("react/jsx-runtime").JSX.Element | null;

export {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  useFormField,
};
//# sourceMappingURL=form.d.ts.map
