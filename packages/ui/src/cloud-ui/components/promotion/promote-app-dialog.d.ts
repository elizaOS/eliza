interface PromoteAppDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  app: {
    id: string;
    name: string;
    description?: string;
    app_url: string;
  };
  adAccounts?: Array<{
    id: string;
    platform: string;
    accountName: string;
  }>;
}
export declare function PromoteAppDialog({
  open,
  onOpenChange,
  app,
  adAccounts,
}: PromoteAppDialogProps): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=promote-app-dialog.d.ts.map
