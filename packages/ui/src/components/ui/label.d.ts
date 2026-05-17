import * as LabelPrimitive from "@radix-ui/react-label";
import * as React from "react";

declare const Label: React.ForwardRefExoticComponent<
  Omit<
    LabelPrimitive.LabelProps & React.RefAttributes<HTMLLabelElement>,
    "ref"
  > &
    React.RefAttributes<HTMLLabelElement>
>;

export { Label };
//# sourceMappingURL=label.d.ts.map
