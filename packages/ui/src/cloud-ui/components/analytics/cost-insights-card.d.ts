import { type CostAlertsTrending } from "./cost-alerts";
interface CostInsightsCardProps {
    costTrending: CostAlertsTrending & {
        monthlyBurnPercentClamped: number;
    };
    creditBalance: number;
}
export declare function CostInsightsCard({ costTrending, creditBalance, }: CostInsightsCardProps): import("react/jsx-runtime").JSX.Element;
export type { CostInsightsCardProps };
//# sourceMappingURL=cost-insights-card.d.ts.map