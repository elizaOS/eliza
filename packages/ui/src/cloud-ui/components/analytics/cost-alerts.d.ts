interface CostAlertsTrending {
    currentDailyBurn: number;
    burnChangePercent: number;
    daysUntilBalanceZero: number | null;
    projectedMonthlyBurn: number;
    monthlyBurnPercent: number;
    burnAlertThresholdExceeded: boolean;
}
interface CostAlertsProps {
    costTrending: CostAlertsTrending;
    creditBalance: number;
}
export declare function CostAlerts({ costTrending }: CostAlertsProps): import("react/jsx-runtime").JSX.Element;
export type { CostAlertsProps, CostAlertsTrending };
//# sourceMappingURL=cost-alerts.d.ts.map