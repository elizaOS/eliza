/** Native form boundary used by reusable compositions that submit user input. */
import * as React from "react";

import { cn } from "../../utils/cn";

export const SemanticForm = React.forwardRef<
  HTMLFormElement,
  React.FormHTMLAttributes<HTMLFormElement>
>(({ className, ...props }, ref) => (
  <form ref={ref} className={cn(className)} {...props} />
));
SemanticForm.displayName = "SemanticForm";
