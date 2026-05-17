import * as DialogPrimitive from "@radix-ui/react-dialog";
import * as React from "react";
declare const DrawerSheet: React.FC<DialogPrimitive.DialogProps>;
declare const DrawerSheetTrigger: React.ForwardRefExoticComponent<DialogPrimitive.DialogTriggerProps & React.RefAttributes<HTMLButtonElement>>;
declare const DrawerSheetPortal: React.FC<DialogPrimitive.DialogPortalProps>;
declare const DrawerSheetClose: React.ForwardRefExoticComponent<DialogPrimitive.DialogCloseProps & React.RefAttributes<HTMLButtonElement>>;
declare const DrawerSheetOverlay: React.ForwardRefExoticComponent<Omit<DialogPrimitive.DialogOverlayProps & React.RefAttributes<HTMLDivElement>, "ref"> & React.RefAttributes<HTMLDivElement>>;
declare const DrawerSheetContent: React.ForwardRefExoticComponent<Omit<DialogPrimitive.DialogContentProps & React.RefAttributes<HTMLDivElement>, "ref"> & {
    container?: HTMLElement | null;
    showCloseButton?: boolean;
} & React.RefAttributes<HTMLDivElement>>;
declare const DrawerSheetHeader: {
    ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>): import("react/jsx-runtime").JSX.Element;
    displayName: string;
};
declare const DrawerSheetTitle: React.ForwardRefExoticComponent<Omit<DialogPrimitive.DialogTitleProps & React.RefAttributes<HTMLHeadingElement>, "ref"> & React.RefAttributes<HTMLHeadingElement>>;
declare const DrawerSheetDescription: React.ForwardRefExoticComponent<Omit<DialogPrimitive.DialogDescriptionProps & React.RefAttributes<HTMLParagraphElement>, "ref"> & React.RefAttributes<HTMLParagraphElement>>;
export { DrawerSheet, DrawerSheetClose, DrawerSheetContent, DrawerSheetDescription, DrawerSheetHeader, DrawerSheetOverlay, DrawerSheetPortal, DrawerSheetTitle, DrawerSheetTrigger, };
//# sourceMappingURL=drawer-sheet.d.ts.map