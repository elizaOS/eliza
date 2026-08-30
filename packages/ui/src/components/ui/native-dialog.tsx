/**
 * Exposes the browser top-layer dialog for surfaces that require native
 * `showModal`, `close`, and `::backdrop` behavior instead of a portalled dialog.
 */

import * as React from "react";

export type NativeDialogProps = React.DialogHTMLAttributes<HTMLDialogElement>;

export const NativeDialog = React.forwardRef<
  HTMLDialogElement,
  NativeDialogProps
>((props, ref) => <dialog ref={ref} {...props} />);
NativeDialog.displayName = "NativeDialog";
